//! Private, bounded recovery records. No credentials, host transcript, or tool registry.
//! Lineage stores only semantic hashes, never transcript text or image bytes.
//! Checkpoints are opaque bytes: decoding/re-encoding them would discard future fields.
use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, ensure, Result};
use serde_json::Value;

use crate::{sha256::Sha256, types::PendingTool};

pub(crate) const MAX_BLOBS: usize = 512;
pub(crate) const MAX_BLOB: usize = 32 * 1024 * 1024;
pub(crate) const MAX_STORE: usize = 128 * 1024 * 1024;
const MAX_TOOLS: usize = 512;
const MAX_INPUT: usize = 1024 * 1024;
const MAX_RESULT: usize = 16 * 1024 * 1024;
const MAX_RESULTS: usize = 32 * 1024 * 1024;
const MAX_RECORD: u64 = (MAX_STORE + MAX_BLOB + MAX_RESULTS + 8 * 1024 * 1024) as u64;
const CACHE_BYTES: u64 = 1024 * 1024 * 1024;
const CACHE_ENTRIES: usize = 4096;
const SCAN_LIMIT: usize = 16_384;
const ROOT_TEMP: &str = ".cache-commit.tmp";
const MAGIC: &[u8; 8] = b"CURSRJ03";
const LEGACY_MAGIC: &[u8; 8] = b"CURSRJ02";
pub(crate) const MAX_HISTORY: usize = 16_384;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HistoryItem {
    pub kind: u8,
    pub digest: [u8; 32],
}
#[derive(Clone)]
pub(crate) struct Lineage {
    pub history: Vec<HistoryItem>,
    pub configuration: [u8; 32],
    // Set durably before output is exposed, cleared only after its hash is sealed.
    pub output_pending: bool,
    // A known host-result handoff, not an arbitrary interrupted active turn.
    pub awaiting_results: bool,
    pub tainted: bool,
}
const TTL: u64 = 24 * 60 * 60;

#[derive(Clone)]
pub(crate) struct Pending {
    pub tool: PendingTool,
    pub exposed: bool,
}
#[derive(Clone)]
pub(crate) struct Completed {
    pub tool: PendingTool,
    pub output: Value,
}
#[derive(Clone)]
pub(crate) struct Record {
    pub scope: String,
    pub binding: [u8; 32],
    pub conversation: String,
    pub updated: u64,
    pub in_flight: bool,
    pub had_actions: bool,
    pub checkpoint: Vec<u8>,
    pub blobs: HashMap<String, Vec<u8>>,
    pub pending: BTreeMap<String, Pending>,
    pub completed: BTreeMap<String, Completed>,
    pub lineage: Option<Lineage>,
    // Shared conservatively across ledger snapshots; JSON/container overhead and
    // deep snapshot copies are not an RSS guarantee.
    _resident: Arc<crate::resource::Lease>,
}
impl Record {
    pub fn new(scope: String, binding: [u8; 32]) -> Self {
        Self {
            scope,
            binding,
            conversation: uuid::Uuid::new_v4().to_string(),
            updated: now(),
            in_flight: false,
            had_actions: false,
            checkpoint: Vec::new(),
            blobs: HashMap::new(),
            pending: BTreeMap::new(),
            completed: BTreeMap::new(),
            lineage: None,
            _resident: Arc::new(crate::resource::Lease::default()),
        }
    }
    pub fn take_resident(&mut self) -> crate::resource::Lease {
        let shared = std::mem::replace(
            &mut self._resident,
            Arc::new(crate::resource::Lease::default()),
        );
        match Arc::try_unwrap(shared) {
            Ok(lease) => lease,
            Err(shared) => {
                // Other deep snapshots still own their original charge.
                self._resident = shared;
                crate::resource::Lease::default()
            }
        }
    }
    pub fn resident_bytes(&self) -> usize {
        let tool_bytes = |tool: &PendingTool| {
            tool.exec_id.capacity()
                + tool.tool_call_id.capacity()
                + tool.name.capacity()
                + crate::resource::value_bytes(&tool.input)
        };
        self.checkpoint.capacity()
            + self.blobs.values().map(Vec::capacity).sum::<usize>()
            + self
                .pending
                .values()
                .map(|p| tool_bytes(&p.tool))
                .sum::<usize>()
            + self
                .completed
                .values()
                .map(|c| tool_bytes(&c.tool) + crate::resource::value_bytes(&c.output))
                .sum::<usize>()
    }
    pub fn validate(&self) -> Result<()> {
        validate_scope(&self.scope)?;
        ensure!(
            !self.conversation.is_empty() && self.conversation.len() <= 128,
            "Invalid journal conversation"
        );
        ensure!(
            self.checkpoint.len() <= MAX_BLOB,
            "Journal checkpoint limit exceeded"
        );
        ensure!(
            self.blobs.len() <= MAX_BLOBS,
            "Journal blob count limit exceeded"
        );
        let mut bytes = 0usize;
        for (key, blob) in &self.blobs {
            // Cursor KV ids are opaque bytes, not necessarily SHA-256 hashes.
            ensure!(
                !key.is_empty() && key.len() <= 512 && key.bytes().all(|b| b.is_ascii_hexdigit()),
                "Invalid journal blob id"
            );
            ensure!(blob.len() <= MAX_BLOB, "Journal blob size limit exceeded");
            bytes = bytes
                .checked_add(blob.len())
                .ok_or_else(|| anyhow!("Journal size overflow"))?;
        }
        ensure!(bytes <= MAX_STORE, "Journal blob store limit exceeded");
        ensure!(
            self.pending.len() + self.completed.len() <= MAX_TOOLS,
            "Journal tool ledger is full; refusing to evict action identities"
        );
        if let Some(lineage) = &self.lineage {
            ensure!(
                lineage.history.len() <= MAX_HISTORY,
                "Journal lineage limit exceeded"
            );
            ensure!(
                lineage.history.iter().all(|item| item.kind <= 5),
                "Invalid journal history kind"
            );
        }
        let mut results = 0usize;
        for (id, pending) in &self.pending {
            validate_tool(&pending.tool)?;
            ensure!(
                id == &pending.tool.tool_call_id && !self.completed.contains_key(id),
                "Invalid journal pending identity"
            );
            results += bounded_json(&pending.tool.input, MAX_INPUT)?.len();
        }
        for (id, done) in &self.completed {
            validate_tool(&done.tool)?;
            ensure!(
                id == &done.tool.tool_call_id,
                "Invalid journal completed identity"
            );
            results += bounded_json(&done.tool.input, MAX_INPUT)?.len();
            results += bounded_json(&done.output, MAX_RESULT)?.len();
        }
        ensure!(
            results <= MAX_RESULTS,
            "Journal result ledger byte limit exceeded"
        );
        Ok(())
    }
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
pub(crate) fn validate_scope(scope: &str) -> Result<()> {
    ensure!(
        scope.len() == 64
            && scope
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Scope must be a lowercase SHA-256 binding"
    );
    Ok(())
}
fn validate_tool(tool: &PendingTool) -> Result<()> {
    for id in [&tool.exec_id, &tool.tool_call_id, &tool.name] {
        ensure!(
            !id.is_empty() && id.len() <= 1024 && !id.contains('\0'),
            "Invalid journal tool identity"
        );
    }
    bounded_json(&tool.input, MAX_INPUT)?;
    Ok(())
}
// Stop serialization at the limit rather than allocating an unbounded JSON buffer.
fn bounded_json(value: &Value, max: usize) -> Result<Vec<u8>> {
    struct Limited {
        bytes: Vec<u8>,
        max: usize,
    }
    impl Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.max.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other("JSON limit"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Limited {
        bytes: Vec::new(),
        max,
    };
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| anyhow!("Journal JSON exceeds its limit"))?;
    Ok(writer.bytes)
}

// Descriptor-relative operations anchor every lookup. A path check followed by a
// normal open/rename is NOT enough: an ancestor can be swapped for a symlink.
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod private_fs {
    use super::*;
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd, IntoRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
    };
    unsafe extern "C" {
        fn openat(fd: i32, name: *const std::ffi::c_char, flags: i32, ...) -> i32;
        fn mkdirat(fd: i32, name: *const std::ffi::c_char, mode: u32) -> i32;
        fn renameat(
            old: i32,
            from: *const std::ffi::c_char,
            new: i32,
            to: *const std::ffi::c_char,
        ) -> i32;
        fn unlinkat(fd: i32, name: *const std::ffi::c_char, flags: i32) -> i32;
        fn geteuid() -> u32;
        fn flock(fd: i32, operation: i32) -> i32;
        // Intel Darwin must select the same 64-bit-inode ABI for the directory
        // constructor and iterator, as Apple's headers and libc bindings do.
        #[cfg_attr(
            all(target_os = "macos", target_arch = "x86_64"),
            link_name = "fdopendir$INODE64"
        )]
        fn fdopendir(fd: i32) -> *mut std::ffi::c_void;
        #[cfg_attr(
            all(target_os = "macos", target_arch = "x86_64"),
            link_name = "readdir$INODE64"
        )]
        fn readdir(dir: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn closedir(dir: *mut std::ffi::c_void) -> i32;
        #[cfg(target_os = "macos")]
        fn __error() -> *mut i32;
        #[cfg(target_os = "linux")]
        fn __errno_location() -> *mut i32;
    }
    #[cfg(target_os = "macos")]
    const FLAGS: (i32, i32, i32, i32, i32, i32) = (0x100000, 0x100, 0x1000000, 0x200, 0x800, 4);
    #[cfg(not(target_os = "macos"))]
    const FLAGS: (i32, i32, i32, i32, i32, i32) = (0x10000, 0x20000, 0x80000, 0x40, 0x80, 0x800);
    fn name(value: &[u8]) -> Result<CString> {
        CString::new(value).map_err(|_| anyhow!("Invalid journal path"))
    }
    fn open(dir: &File, part: &CString, flags: i32) -> Result<File> {
        // SAFETY: directory fd and NUL-terminated name remain valid for this call.
        let fd = unsafe { openat(dir.as_raw_fd(), part.as_ptr(), flags, 0o600u32) };
        if fd < 0 {
            return Err(
                anyhow::Error::new(std::io::Error::last_os_error()).context(format!(
                    "Cannot safely open private journal entry {:?}",
                    part
                )),
            );
        }
        // SAFETY: successful openat returns an owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub fn directory(path: &Path) -> Result<File> {
        directory_mode(path, true)
    }
    pub fn existing_directory(path: &Path) -> Result<File> {
        directory_mode(path, false)
    }
    fn directory_mode(path: &Path, create: bool) -> Result<File> {
        ensure!(path.is_absolute(), "Journal directory must be absolute");
        let mut dir = File::open("/")?;
        let mut count = 0;
        for component in path.components() {
            match component {
                Component::RootDir => continue,
                Component::Normal(part) => {
                    count += 1;
                    let part = name(part.as_bytes())?;
                    // mkdirat never follows an existing link; the subsequent open is NOFOLLOW.
                    if create && unsafe { mkdirat(dir.as_raw_fd(), part.as_ptr(), 0o700) } == 0 {
                        // A durable file in a newly created directory is not enough:
                        // its parent must durably retain the new directory link too.
                        dir.sync_all()?;
                    }
                    dir = open(&dir, &part, FLAGS.0 | FLAGS.1 | FLAGS.2)?;
                    ensure!(
                        dir.metadata()?.is_dir(),
                        "Journal ancestor is not a directory"
                    );
                }
                _ => bail!("Journal directory must not contain traversal components"),
            }
        }
        ensure!(count > 0, "Invalid private journal directory");
        check(&dir, true)?;
        Ok(dir)
    }
    fn check(file: &File, directory: bool) -> Result<()> {
        let m = file.metadata()?;
        ensure!(
            m.uid() == unsafe { geteuid() } && m.mode() & 0o077 == 0,
            "Journal entry is not user-private"
        );
        ensure!(
            if directory {
                m.is_dir()
            } else {
                m.is_file() && m.nlink() == 1
            },
            "Unsafe journal entry type or hard link"
        );
        Ok(())
    }
    // Reopen '.' relative to the pinned descriptor: independent directory cursor,
    // no mutable ancestor lookup and no /dev/fd directory assumption on macOS.
    /// Recognized record names plus the number of directory entries scanned.
    pub fn entries(dir: &File) -> Result<(Vec<String>, usize)> {
        struct Directory(*mut std::ffi::c_void);
        impl Drop for Directory {
            fn drop(&mut self) {
                unsafe {
                    closedir(self.0);
                }
            }
        }
        let file = open(dir, &name(b".")?, FLAGS.0 | FLAGS.1 | FLAGS.2)?;
        let fd = file.into_raw_fd();
        let pointer = unsafe { fdopendir(fd) };
        if pointer.is_null() {
            drop(unsafe { File::from_raw_fd(fd) });
            bail!("cache_scan_failed");
        }
        let directory = Directory(pointer);
        let mut entries = Vec::new();
        let mut count = 0;
        loop {
            #[cfg(target_os = "macos")]
            let errno = unsafe { __error() };
            #[cfg(target_os = "linux")]
            let errno = unsafe { __errno_location() };
            unsafe {
                *errno = 0;
            }
            let entry = unsafe { readdir(directory.0) }.cast::<u8>();
            if entry.is_null() {
                ensure!(unsafe { *errno } == 0, "cache_scan_failed");
                break;
            }
            count += 1;
            ensure!(count <= SCAN_LIMIT, "cache_scan_limit");
            // Darwin/Linux 64-bit dirent ABI: reclen at 16, names at 21/19.
            // Copy/use bytes only until the next readdir call; bound by reclen.
            let length = unsafe { std::ptr::read_unaligned(entry.add(16).cast::<u16>()) } as usize;
            #[cfg(target_os = "macos")]
            let offset = 21;
            #[cfg(target_os = "linux")]
            let offset = 19;
            ensure!(length > offset && length <= 4096, "cache_scan_failed");
            let bytes = unsafe { std::slice::from_raw_parts(entry.add(offset), length - offset) };
            let end = bytes
                .iter()
                .position(|b| *b == 0)
                .ok_or_else(|| anyhow!("cache_scan_failed"))?;
            let Ok(name) = std::str::from_utf8(&bytes[..end]) else {
                continue;
            };
            if let Some(scope) = name.strip_suffix(".bin") {
                if validate_scope(scope).is_ok() {
                    entries.push(name.to_owned());
                }
            }
        }
        Ok((entries, count))
    }
    pub fn lock(dir: &File, scope: &str) -> Result<File> {
        lock_mode(dir, scope, true, false)
    }
    pub fn existing_lock(dir: &File, scope: &str) -> Result<File> {
        lock_mode(dir, scope, false, false)
    }
    // FIFO admission is keyed by the pinned directory, never a mutable path.
    // Weak entries are swept and both registry and waiter counts are bounded.
    // The OS contention deadline starts at the head, not while local peers work.
    // Filesystem syscalls themselves cannot be interrupted by this deadline.
    #[derive(Default)]
    struct Admission {
        state: Mutex<(bool, std::collections::VecDeque<u64>, u64)>,
        ready: std::sync::Condvar,
    }
    struct LocalGuard(Arc<Admission>);
    impl Drop for LocalGuard {
        fn drop(&mut self) {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            state.0 = false;
            self.0.ready.notify_all();
        }
    }
    pub struct QuotaGuard {
        // Release the OS lock before admitting the next local writer.
        _file: File,
        _local: LocalGuard,
    }
    fn local_admission(dir: &File) -> Result<LocalGuard> {
        type Registry = HashMap<(u64, u64), std::sync::Weak<Admission>>;
        static ROOTS: std::sync::OnceLock<Mutex<Registry>> = std::sync::OnceLock::new();
        let metadata = dir.metadata()?;
        let key = (metadata.dev(), metadata.ino());
        let admission = {
            let mut roots = ROOTS
                .get_or_init(Mutex::default)
                .lock()
                .map_err(|_| anyhow!("cache_registry_unavailable"))?;
            roots.retain(|_, weak| weak.strong_count() > 0);
            if let Some(admission) = roots.get(&key).and_then(std::sync::Weak::upgrade) {
                admission
            } else {
                if roots.len() >= CACHE_ENTRIES {
                    return Err(RootBusy.into());
                }
                let admission = Arc::new(Admission::default());
                roots.insert(key, Arc::downgrade(&admission));
                admission
            }
        };
        let mut state = admission
            .state
            .lock()
            .map_err(|_| anyhow!("cache_registry_unavailable"))?;
        if state.1.len() >= CACHE_ENTRIES {
            return Err(RootBusy.into());
        }
        let ticket = state.2;
        state.2 = state.2.wrapping_add(1);
        state.1.push_back(ticket);
        while state.0 || state.1.front() != Some(&ticket) {
            state = admission
                .ready
                .wait(state)
                .unwrap_or_else(|e| e.into_inner());
        }
        state.1.pop_front();
        state.0 = true;
        drop(state);
        Ok(LocalGuard(admission))
    }
    pub fn quota_lock(dir: &File) -> Result<QuotaGuard> {
        let local = local_admission(dir)?;
        let file = lock_mode(dir, ".cache-quota", true, true)?;
        Ok(QuotaGuard {
            _file: file,
            _local: local,
        })
    }
    #[cfg(test)]
    impl QuotaGuard {
        pub fn metadata(&self) -> std::io::Result<std::fs::Metadata> {
            self._file.metadata()
        }
    }
    fn lock_mode(dir: &File, scope: &str, create: bool, wait: bool) -> Result<File> {
        let flags = FLAGS.1 | FLAGS.2 | FLAGS.5 | if create { 2 } else { 0 };
        let part = name(format!("{scope}.lock").as_bytes())?;
        let file = if create {
            // Racing non-exclusive O_CREAT opens can return ENOENT on macOS.
            // Elect a creator, then open the winner without O_CREAT. Lock files
            // are never unlinked; every contender still validates the same inode.
            match open(dir, &part, flags | FLAGS.3 | FLAGS.4) {
                Ok(file) => file,
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists) =>
                {
                    open(dir, &part, flags)?
                }
                Err(error) => return Err(error),
            }
        } else {
            open(dir, &part, flags)?
        };
        check(&file, false)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if unsafe { flock(file.as_raw_fd(), 2 | 4) } == 0 {
                return Ok(file);
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::WouldBlock {
                return Err(error.into());
            }
            if !wait {
                bail!("Scope journal is already in use");
            }
            if std::time::Instant::now() >= deadline {
                return Err(RootBusy.into());
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    pub fn read(dir: &File, entry: &str) -> Result<Option<File>> {
        let part = name(entry.as_bytes())?;
        let fd = unsafe { openat(dir.as_raw_fd(), part.as_ptr(), FLAGS.1 | FLAGS.2 | FLAGS.5) };
        if fd < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            bail!("Cannot safely read journal");
        }
        let file = unsafe { File::from_raw_fd(fd) };
        check(&file, false)?;
        Ok(Some(file))
    }
    pub fn create(dir: &File, entry: &str) -> Result<File> {
        let file = open(
            dir,
            &name(entry.as_bytes())?,
            1 | FLAGS.1 | FLAGS.2 | FLAGS.3 | FLAGS.4,
        )?;
        check(&file, false)?;
        Ok(file)
    }
    pub fn rename(dir: &File, from: &str, to: &str) -> Result<()> {
        let from = name(from.as_bytes())?;
        let to = name(to.as_bytes())?;
        ensure!(
            unsafe { renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) } == 0,
            "Cannot commit journal"
        );
        dir.sync_all()?;
        Ok(())
    }
    pub fn remove(dir: &File, entry: &str) -> Result<()> {
        let entry = name(entry.as_bytes())?;
        if unsafe { unlinkat(dir.as_raw_fd(), entry.as_ptr(), 0) } != 0 {
            ensure!(
                std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound,
                "Cannot remove journal"
            );
        }
        dir.sync_all()?;
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod private_fs {
    use super::*;
    pub fn entries(_: &File) -> Result<(Vec<String>, usize)> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn directory(_: &Path) -> Result<File> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn existing_directory(_: &Path) -> Result<File> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn existing_lock(_: &File, _: &str) -> Result<File> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn quota_lock(_: &File) -> Result<File> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn lock(_: &File, _: &str) -> Result<File> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn read(_: &File, _: &str) -> Result<Option<File>> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn create(_: &File, _: &str) -> Result<File> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn rename(_: &File, _: &str, _: &str) -> Result<()> {
        bail!("Private recovery journals require Linux or macOS")
    }
    pub fn remove(_: &File, _: &str) -> Result<()> {
        bail!("Private recovery journals require Linux or macOS")
    }
}

#[derive(Debug)]
pub(crate) struct RootBusy;
impl std::fmt::Display for RootBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cache_root_busy")
    }
}
impl std::error::Error for RootBusy {}

#[derive(Clone)]
pub(crate) struct Journal(Arc<JournalInner>);
struct JournalInner {
    dir: File,
    _lock: File,
    entry: String,
    // Also serializes remove against a final atomic commit. No late resurrection.
    enabled: Mutex<bool>,
    #[cfg(test)]
    fault: Mutex<Option<Fault>>,
    #[cfg(test)]
    commits: std::sync::atomic::AtomicUsize,
}
#[cfg(test)]
#[derive(Clone, Copy)]
enum Fault {
    ShortWrite,
    NoSpace,
    Io,
    Sync,
    Rename,
    DirectorySync,
}

/// Numeric root counters from the latest commit admission in this loaded core. No paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CacheUsage {
    pub bytes: u64,
    pub records: usize,
    pub entries: usize,
}
static OBSERVED: Mutex<Option<CacheUsage>> = Mutex::new(None);
pub(crate) fn observed_usage() -> Option<CacheUsage> {
    *OBSERVED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
pub(crate) const CAPACITY_CODES: [&str; 3] = [
    "cache_quota_exceeded",
    "cache_entry_quota_exceeded",
    "cache_scan_limit",
];
/// Capacity exhaustion is an operator condition, not a corrupt or uncertain record.
pub(crate) fn capacity_code(error: &anyhow::Error) -> Option<&'static str> {
    if error.is::<RootBusy>() {
        return Some("cache_root_busy");
    }
    let message = error.to_string();
    CAPACITY_CODES.into_iter().find(|code| message == *code)
}
fn cache_totals(dir: &File, entry: &str) -> Result<(u64, usize, Option<u64>)> {
    let mut bytes = 0u64;
    let mut count = 0;
    let mut previous = None;
    let (names, scanned) = private_fs::entries(dir)?;
    for name in names {
        let file = match private_fs::read(dir, &name) {
            Ok(Some(file)) => file,
            Ok(None) => continue,
            // Never follow or operate on unsafe unrelated entries. The target
            // itself must be safe; an unsafe target cannot be overwritten.
            Err(error) if name == entry => return Err(error),
            Err(_) => continue,
        };
        let size = file.metadata()?.len();
        bytes = bytes
            .checked_add(size)
            .ok_or_else(|| anyhow!("cache_quota_exceeded"))?;
        count += 1;
        if name == entry {
            previous = Some(size);
        }
    }
    *OBSERVED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(CacheUsage {
        bytes,
        records: count,
        entries: scanned,
    });
    Ok((bytes, count, previous))
}
fn encoded_size(record: &Record) -> Result<u64> {
    struct Count(u64);
    impl Write for Count {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0 += b.len() as u64;
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    encode_with(&mut count, record, false, None)?;
    Ok(count.0)
}

/// Explicit maintenance is rooted only by Engine's known-scope registry.
/// Tombstones never authorize replay/reset. Corrupt, locked and unknown files survive.
pub(crate) fn maintain(path: &Path, apply: bool) -> Result<String> {
    let dir = private_fs::existing_directory(path)?;
    let (entries, directory_entries) = private_fs::entries(&dir)?;
    let mut committed = 0u64;
    let mut scanned = 0u64;
    let mut skipped = 0u64;
    let mut expired = 0u64;
    let mut reclaimed = 0u64;
    let mut applied = 0u64;
    for name in entries {
        scanned += 1;
        // Capacity is reported for every safe record, including active and locked ones.
        if let Ok(Some(file)) = private_fs::read(&dir, &name) {
            committed = committed.saturating_add(file.metadata().map_or(0, |m| m.len()));
        }
        let scope = &name[..64];
        let Ok(journal) = dir.try_clone().and_then(|dir| {
            Journal::open_directory(dir, scope, false).map_err(std::io::Error::other)
        }) else {
            skipped += 1;
            continue;
        };
        let result = (|| -> Result<Option<u64>> {
            let Some(mut file) = private_fs::read(&journal.0.dir, &name)? else {
                return Ok(None);
            };
            let size = file.metadata()?.len();
            ensure!(size <= MAX_RECORD, "cache_record_oversized");
            let _lease = crate::resource::Lease::reserve(size as usize)?;
            let mut header = [0u8; 108];
            file.read_exact(&mut header)?;
            ensure!(
                (&header[..8] == MAGIC || &header[..8] == LEGACY_MAGIC)
                    && header[8..12] == 64u32.to_le_bytes(),
                "cache_unrecognized"
            );
            let mut binding = [0; 32];
            binding.copy_from_slice(&header[76..108]);
            file.seek(SeekFrom::Start(0))?;
            let record = decode_inner(file, binding, true)?;
            ensure!(record.scope == scope, "cache_scope_mismatch");
            if now().saturating_sub(record.updated) <= TTL {
                return Ok(None);
            }
            if apply {
                journal.replace(8, |file| {
                    file.write_all(b"CURSREXP")?;
                    Ok(())
                })?;
            }
            Ok(Some(size.saturating_sub(8)))
        })();
        match result {
            Ok(Some(bytes)) => {
                expired += 1;
                reclaimed += bytes;
                if apply {
                    applied += 1;
                }
            }
            Ok(None) => {}
            Err(_) => skipped += 1,
        }
    }
    Ok(serde_json::json!({"code":"cache_maintenance", "apply":apply,"scanned":scanned,"skipped":skipped,"expired":expired,"applied":applied,"reclaimableBytes":reclaimed,
        "committedBytes":committed,"limitBytes":CACHE_BYTES,"records":scanned,"limitRecords":CACHE_ENTRIES,
        "directoryEntries":directory_entries,"scanLimitEntries":SCAN_LIMIT}).to_string())
}
impl Journal {
    pub fn open(path: &Path, scope: &str) -> Result<Self> {
        validate_scope(scope)?;
        Self::open_directory(private_fs::directory(path)?, scope, true)
    }
    fn open_directory(dir: File, scope: &str, cleanup: bool) -> Result<Self> {
        validate_scope(scope)?;
        {
            let lock = if cleanup {
                private_fs::lock(&dir, scope)?
            } else {
                private_fs::existing_lock(&dir, scope)?
            };
            // One deterministic staging file per locked scope; a crash cannot
            // accumulate a fresh 200 MiB temporary file on every attempted save.
            let temporary = format!(".{scope}.tmp");
            if cleanup {
                private_fs::remove(&dir, &temporary)?;
            }
            Ok(Self(Arc::new(JournalInner {
                dir,
                _lock: lock,
                entry: format!("{scope}.bin"),
                enabled: Mutex::new(true),
                #[cfg(test)]
                fault: Mutex::new(None),
                #[cfg(test)]
                commits: std::sync::atomic::AtomicUsize::new(0),
            })))
        }
    }
    pub fn load(&self, binding: [u8; 32]) -> Result<Option<Record>> {
        let enabled = self
            .0
            .enabled
            .lock()
            .map_err(|_| anyhow!("Journal lock failed"))?;
        ensure!(*enabled, "Scope was removed");
        let Some(file) = private_fs::read(&self.0.dir, &self.0.entry)? else {
            return Ok(None);
        };
        let size = file.metadata()?.len();
        ensure!(size <= MAX_RECORD, "Journal file exceeds size limit");
        let lease = crate::resource::Lease::reserve(size as usize)?;
        let result = decode(file, binding).map(|mut record| {
            record._resident = Arc::new(lease);
            record
        });
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e.to_string() == "Journal expired")
        {
            // On access, discard expired payloads but retain a non-sensitive
            // tombstone: treating expiration as an empty/new scope could repeat
            // an action whose result is now unavailable. Explicit remove resets it.
            self.replace(8, |file| {
                file.write_all(b"CURSREXP")?;
                Ok(())
            })?;
        }
        result.map(Some).map_err(|_| anyhow!("Recovery journal is expired, corrupt, oversized, or has a different binding; explicitly remove the scope to discard it"))
    }
    #[cfg(test)]
    pub(crate) fn commits_for_test(&self) -> usize {
        self.0.commits.load(std::sync::atomic::Ordering::Relaxed)
    }
    #[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
    pub(crate) fn hold_quota_for_test(&self) -> Result<File> {
        // Bypass cooperating admission to simulate an external process owner.
        private_fs::lock(&self.0.dir, ".cache-quota")
    }
    pub fn save(&self, record: &Record) -> Result<()> {
        record.validate()?;
        ensure!(
            self.0.entry == format!("{}.bin", record.scope),
            "Journal scope mismatch"
        );
        let enabled = self
            .0
            .enabled
            .lock()
            .map_err(|_| anyhow!("Journal lock failed"))?;
        ensure!(*enabled, "Scope was removed");
        self.replace(encoded_size(record)?, |file| encode(file, record))
    }
    fn replace(&self, size: u64, write: impl FnOnce(&mut dyn Write) -> Result<()>) -> Result<()> {
        // Bounded cross-process admission BEFORE touching on-disk state. Callers
        // must still fence pre-persist in-memory mutations on admission failure.
        let _quota = private_fs::quota_lock(&self.0.dir)?;
        let (bytes, count, previous) = cache_totals(&self.0.dir, &self.0.entry)?;
        let next = bytes
            .saturating_sub(previous.unwrap_or(0))
            .checked_add(size)
            .ok_or_else(|| anyhow!("cache_quota_exceeded"))?;
        ensure!(
            size <= MAX_RECORD && (next <= CACHE_BYTES || previous.is_some_and(|old| size <= old)),
            "cache_quota_exceeded"
        );
        ensure!(
            count + usize::from(previous.is_none()) <= CACHE_ENTRIES || previous.is_some(),
            "cache_entry_quota_exceeded"
        );
        private_fs::remove(&self.0.dir, ROOT_TEMP)?;
        let result: Result<()> = (|| {
            let mut file = private_fs::create(&self.0.dir, ROOT_TEMP)?;
            #[cfg(test)]
            let fault = self
                .0
                .fault
                .lock()
                .map_err(|_| anyhow!("test fault lock"))?
                .take();
            #[cfg(test)]
            {
                struct FaultWriter<'a> {
                    file: &'a mut File,
                    fault: Option<Fault>,
                    bytes: usize,
                }
                impl Write for FaultWriter<'_> {
                    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                        if self.bytes >= 13 {
                            match self.fault {
                                Some(Fault::NoSpace) => {
                                    return Err(std::io::Error::from_raw_os_error(28))
                                }
                                Some(Fault::Io) => {
                                    return Err(std::io::Error::from_raw_os_error(5))
                                }
                                _ => {}
                            }
                        }
                        let n = if matches!(
                            self.fault,
                            Some(Fault::ShortWrite | Fault::NoSpace | Fault::Io)
                        ) {
                            b.len().min(3)
                        } else {
                            b.len()
                        };
                        let n = self.file.write(&b[..n])?;
                        self.bytes += n;
                        Ok(n)
                    }
                    fn flush(&mut self) -> std::io::Result<()> {
                        self.file.flush()
                    }
                }
                write(&mut FaultWriter {
                    file: &mut file,
                    fault,
                    bytes: 0,
                })?;
                ensure!(!matches!(fault, Some(Fault::Sync)), "injected sync failure");
            }
            #[cfg(not(test))]
            write(&mut file)?;
            file.sync_all()?;
            #[cfg(test)]
            ensure!(
                !matches!(fault, Some(Fault::Rename)),
                "injected rename failure"
            );
            private_fs::rename(&self.0.dir, ROOT_TEMP, &self.0.entry)?;
            #[cfg(test)]
            self.0
                .commits
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            #[cfg(test)]
            ensure!(
                !matches!(fault, Some(Fault::DirectorySync)),
                "injected directory sync uncertainty"
            );
            Ok(())
        })();
        if result.is_err() {
            let _ = private_fs::remove(&self.0.dir, ROOT_TEMP);
        }
        result.map_err(|_| {
            anyhow!("Cannot durably commit recovery state; no host action may be exposed or sent")
        })
    }
    pub fn remove(&self) -> Result<()> {
        let mut enabled = self
            .0
            .enabled
            .lock()
            .map_err(|_| anyhow!("Journal lock failed"))?;
        let _quota = private_fs::quota_lock(&self.0.dir)?;
        *enabled = false;
        private_fs::remove(&self.0.dir, &self.0.entry)
    }
}

struct Encoder<W> {
    io: W,
    // None only while measuring the exact size for quota admission.
    digest: Option<Sha256>,
    bytes: u64,
}
impl<W: Write> Encoder<W> {
    fn raw(&mut self, bytes: &[u8]) -> Result<()> {
        self.bytes += bytes.len() as u64;
        ensure!(self.bytes + 32 <= MAX_RECORD, "Journal size limit exceeded");
        self.io.write_all(bytes)?;
        if let Some(digest) = &mut self.digest {
            digest.update(bytes);
        }
        Ok(())
    }
    fn u32(&mut self, n: u32) -> Result<()> {
        self.raw(&n.to_le_bytes())
    }
    fn bytes(&mut self, bytes: &[u8]) -> Result<()> {
        self.u32(u32::try_from(bytes.len())?)?;
        self.raw(bytes)
    }
    fn tool(&mut self, tool: &PendingTool) -> Result<()> {
        self.bytes(tool.exec_id.as_bytes())?;
        self.u32(tool.exec_message_id)?;
        self.bytes(tool.tool_call_id.as_bytes())?;
        self.bytes(tool.name.as_bytes())?;
        self.bytes(&bounded_json(&tool.input, MAX_INPUT)?)
    }
}
fn encode(writer: impl Write, r: &Record) -> Result<()> {
    encode_version(writer, r, false)
}
fn encode_version(writer: impl Write, r: &Record, legacy: bool) -> Result<()> {
    encode_with(writer, r, legacy, Some(Sha256::new()))
}
fn encode_with(writer: impl Write, r: &Record, legacy: bool, digest: Option<Sha256>) -> Result<()> {
    let mut e = Encoder {
        io: writer,
        digest,
        bytes: 0,
    };
    e.raw(if legacy { LEGACY_MAGIC } else { MAGIC })?;
    e.bytes(r.scope.as_bytes())?;
    e.raw(&r.binding)?;
    e.bytes(r.conversation.as_bytes())?;
    e.raw(&r.updated.to_le_bytes())?;
    e.raw(&[u8::from(r.in_flight), u8::from(r.had_actions)])?;
    e.bytes(&r.checkpoint)?;
    e.u32(r.blobs.len() as u32)?;
    for (key, value) in &r.blobs {
        e.bytes(key.as_bytes())?;
        e.bytes(value)?;
    }
    e.u32(r.pending.len() as u32)?;
    for p in r.pending.values() {
        e.tool(&p.tool)?;
        e.raw(&[u8::from(p.exposed)])?;
    }
    e.u32(r.completed.len() as u32)?;
    for c in r.completed.values() {
        e.tool(&c.tool)?;
        e.bytes(&bounded_json(&c.output, MAX_RESULT)?)?;
    }
    if !legacy {
        e.raw(&[u8::from(r.lineage.is_some())])?;
        if let Some(lineage) = &r.lineage {
            e.raw(&lineage.configuration)?;
            e.raw(&[
                u8::from(lineage.output_pending),
                u8::from(lineage.awaiting_results),
                u8::from(lineage.tainted),
            ])?;
            e.u32(lineage.history.len() as u32)?;
            for item in &lineage.history {
                e.raw(&[item.kind])?;
                e.raw(&item.digest)?;
            }
        }
    }
    // The size-only pass still counts a checksum-sized trailer.
    e.io.write_all(&e.digest.map_or([0; 32], Sha256::finalize))?;
    Ok(())
}
struct Decoder<R> {
    io: R,
    digest: Sha256,
    remaining: usize,
}
impl<R: Read> Decoder<R> {
    fn raw(&mut self, out: &mut [u8]) -> Result<()> {
        ensure!(out.len() <= self.remaining, "Journal size limit exceeded");
        self.remaining -= out.len();
        self.io.read_exact(out)?;
        self.digest.update(&*out);
        Ok(())
    }
    fn u32(&mut self) -> Result<u32> {
        let mut b = [0; 4];
        self.raw(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    fn bytes(&mut self, max: usize, budget: &mut usize) -> Result<Vec<u8>> {
        let n = self.u32()? as usize;
        ensure!(
            n <= max && n <= *budget && n <= self.remaining,
            "Journal field exceeds limit"
        );
        *budget -= n;
        let mut b = vec![0; n];
        self.raw(&mut b)?;
        Ok(b)
    }
    fn string(&mut self, max: usize) -> Result<String> {
        Ok(String::from_utf8(self.bytes(max, &mut max.clone())?)?)
    }
    fn boolean(&mut self) -> Result<bool> {
        let mut b = [0];
        self.raw(&mut b)?;
        ensure!(b[0] <= 1, "Invalid boolean");
        Ok(b[0] != 0)
    }
    fn tool(&mut self, budget: &mut usize) -> Result<PendingTool> {
        Ok(PendingTool {
            exec_id: self.string(1024)?,
            exec_message_id: self.u32()?,
            tool_call_id: self.string(1024)?,
            name: self.string(1024)?,
            input: serde_json::from_slice(&self.bytes(MAX_INPUT, budget)?)?,
        })
    }
    fn count(&mut self, max: usize) -> Result<usize> {
        let n = self.u32()? as usize;
        ensure!(n <= max, "Journal entry count exceeds limit");
        Ok(n)
    }
}
fn decode(reader: impl Read, binding: [u8; 32]) -> Result<Record> {
    decode_inner(reader, binding, false)
}
fn decode_inner(reader: impl Read, binding: [u8; 32], allow_expired: bool) -> Result<Record> {
    let mut d = Decoder {
        io: reader,
        digest: Sha256::new(),
        remaining: MAX_RECORD as usize - 32,
    };
    let mut magic = [0; 8];
    d.raw(&mut magic)?;
    ensure!(
        &magic == MAGIC || &magic == LEGACY_MAGIC,
        "Invalid journal version"
    );
    let legacy = &magic == LEGACY_MAGIC;
    let scope = d.string(64)?;
    validate_scope(&scope)?;
    let mut saved_binding = [0; 32];
    d.raw(&mut saved_binding)?;
    ensure!(saved_binding == binding, "Journal binding mismatch");
    let conversation = d.string(128)?;
    let mut t = [0; 8];
    d.raw(&mut t)?;
    let updated = u64::from_le_bytes(t);
    ensure!(
        updated <= now().saturating_add(60),
        "Journal timestamp is invalid"
    );
    let mut r = Record::new(scope, binding);
    r.conversation = conversation;
    r.updated = updated;
    r.in_flight = d.boolean()?;
    r.had_actions = d.boolean()?;
    r.checkpoint = d.bytes(MAX_BLOB, &mut MAX_BLOB.clone())?;
    let mut blob_budget = MAX_STORE;
    for _ in 0..d.count(MAX_BLOBS)? {
        let key = d.string(512)?;
        let value = d.bytes(MAX_BLOB, &mut blob_budget)?;
        ensure!(
            r.blobs.insert(key, value).is_none(),
            "Duplicate journal blob"
        );
    }
    let mut budget = MAX_RESULTS;
    for _ in 0..d.count(MAX_TOOLS)? {
        let tool = d.tool(&mut budget)?;
        let exposed = d.boolean()?;
        ensure!(
            r.pending
                .insert(tool.tool_call_id.clone(), Pending { tool, exposed })
                .is_none(),
            "Duplicate pending id"
        );
    }
    for _ in 0..d.count(MAX_TOOLS - r.pending.len())? {
        let tool = d.tool(&mut budget)?;
        let output = serde_json::from_slice(&d.bytes(MAX_RESULT, &mut budget)?)?;
        ensure!(
            r.completed
                .insert(tool.tool_call_id.clone(), Completed { tool, output })
                .is_none(),
            "Duplicate completed id"
        );
    }
    if !legacy && d.boolean()? {
        let mut configuration = [0; 32];
        d.raw(&mut configuration)?;
        let output_pending = d.boolean()?;
        let awaiting_results = d.boolean()?;
        let tainted = d.boolean()?;
        let mut history = Vec::new();
        for _ in 0..d.count(MAX_HISTORY)? {
            let mut kind = [0];
            let mut digest = [0; 32];
            d.raw(&mut kind)?;
            d.raw(&mut digest)?;
            history.push(HistoryItem {
                kind: kind[0],
                digest,
            });
        }
        r.lineage = Some(Lineage {
            history,
            configuration,
            output_pending,
            awaiting_results,
            tainted,
        });
    }
    let mut checksum = [0; 32];
    d.io.read_exact(&mut checksum)?;
    ensure!(
        checksum.as_slice() == d.digest.finalize().as_slice(),
        "Journal checksum mismatch"
    );
    ensure!(d.io.read(&mut [0])? == 0, "Trailing journal data");
    r.validate()?;
    ensure!(
        allow_expired || now().saturating_sub(updated) <= TTL,
        "Journal expired"
    );
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn record() -> Record {
        Record::new("a".repeat(64), [7; 32])
    }
    fn tool() -> PendingTool {
        PendingTool {
            exec_id: "exec".into(),
            exec_message_id: 9,
            tool_call_id: "call".into(),
            name: "host_write".into(),
            input: json!({"value":42}),
        }
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn descriptor_scan_uses_a_matching_native_abi_and_fresh_directory_cursor() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir()?;
        let parent = tmp.path().canonicalize()?;
        // Temp-directory mode depends on the caller's umask. A public parent is
        // allowed, but it must never itself pass as the private journal root.
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755))?;
        assert!(private_fs::existing_directory(&parent).is_err());
        let root = parent.join("private-scan");
        let dir = private_fs::directory(&root)?;
        assert_eq!(dir.metadata()?.permissions().mode() & 0o777, 0o700);
        let first = format!("{}.bin", "a".repeat(64));
        let second = format!("{}.bin", "b".repeat(64));
        let third = format!("{}.bin", "c".repeat(64));
        for name in [&first[..], &second[..], "not-a-scope.bin", "other.tmp"] {
            drop(private_fs::create(&dir, name)?);
        }
        let (mut names, count) = private_fs::entries(&dir)?;
        names.sort();
        assert_eq!(names, vec![first.clone(), second.clone()]);
        assert!(
            count >= 4,
            "Unrecognized entries still count toward the scan limit"
        );
        let (mut repeated, repeated_count) = private_fs::entries(&dir)?;
        repeated.sort();
        assert_eq!(
            repeated, names,
            "Each scan starts from a fresh descriptor cursor"
        );
        assert_eq!(repeated_count, count);
        drop(private_fs::create(&dir, &third)?);
        let (mut updated, updated_count) = private_fs::entries(&dir)?;
        updated.sort();
        assert_eq!(updated, vec![first, second, third]);
        assert_eq!(
            updated_count,
            count + 1,
            "Later scans observe newly created entries"
        );
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn deterministic_commit_faults_preserve_coherent_record_and_remove_fence() -> Result<()> {
        for fault in [
            Fault::ShortWrite,
            Fault::NoSpace,
            Fault::Io,
            Fault::Sync,
            Fault::Rename,
            Fault::DirectorySync,
        ] {
            let tmp = tempfile::tempdir()?;
            let root = tmp.path().canonicalize()?.join("private");
            let journal = Journal::open(&root, &record().scope)?;
            let mut previous = record();
            previous.in_flight = true;
            previous.had_actions = true;
            previous.pending.insert(
                "call".into(),
                Pending {
                    tool: tool(),
                    exposed: true,
                },
            );
            journal.save(&previous)?;
            let mut next = previous.clone();
            next.checkpoint = vec![7, 8, 9];
            *journal.0.fault.lock().expect("fault") = Some(fault);
            let result = journal.save(&next);
            assert_eq!(result.is_ok(), matches!(fault, Fault::ShortWrite));
            let loaded = journal.load(previous.binding)?.expect("previous or new");
            assert!(loaded.in_flight && loaded.had_actions && loaded.pending["call"].exposed);
            assert_eq!(
                loaded.checkpoint,
                if matches!(fault, Fault::ShortWrite | Fault::DirectorySync) {
                    next.checkpoint
                } else {
                    previous.checkpoint
                }
            );
            assert!(!root.join(ROOT_TEMP).exists());
            journal.remove()?;
            assert!(journal.save(&loaded).is_err());
            assert!(journal.load(loaded.binding).is_err());
            assert!(!root.join(format!("{}.bin", loaded.scope)).exists());
        }
        // ENOSPC must not manufacture a successful first commit either.
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("private");
        let journal = Journal::open(&root, &record().scope)?;
        *journal.0.fault.lock().expect("fault") = Some(Fault::NoSpace);
        assert!(journal.save(&record()).is_err());
        assert!(journal.load(record().binding)?.is_none());
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn maintenance_is_explicit_validated_and_never_removes_uncertainty() -> Result<()> {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("private");
        let mut old = record();
        old.updated = now() - TTL - 1;
        old.in_flight = true;
        old.had_actions = true;
        old.checkpoint = vec![1; 4096];
        old.pending.insert(
            "call".into(),
            Pending {
                tool: tool(),
                exposed: true,
            },
        );
        let journal = Journal::open(&root, &old.scope)?;
        journal.save(&old)?;
        let locked: Value = serde_json::from_str(&maintain(&root, true)?)?;
        assert_eq!(locked["skipped"], 1);
        drop(journal);
        let path = root.join(format!("{}.bin", old.scope));
        let original = std::fs::read(&path)?;
        let dry: Value = serde_json::from_str(&maintain(&root, false)?)?;
        assert_eq!(dry["expired"], 1);
        assert_eq!(dry["applied"], 0);
        assert_eq!(dry["records"], 1);
        assert_eq!(dry["committedBytes"], original.len());
        assert_eq!(dry["limitRecords"], CACHE_ENTRIES);
        // The record and its lock, plus "." and "..": locks count toward the scan limit.
        assert!(dry["directoryEntries"].as_u64().is_some_and(|n| n >= 4));
        assert_eq!(std::fs::read(&path)?, original);
        let corrupt = "b".repeat(64);
        let mut corrupt_bytes = original.clone();
        let n = corrupt_bytes.len() - 1;
        corrupt_bytes[n] ^= 1;
        let mut file =
            private_fs::create(&private_fs::directory(&root)?, &format!("{corrupt}.bin"))?;
        file.write_all(&corrupt_bytes)?;
        symlink(&path, root.join(format!("{}.bin", "c".repeat(64))))?;
        std::fs::hard_link(&path, root.join(format!("{}.bin", "d".repeat(64))))?;
        let skipped: Value = serde_json::from_str(&maintain(&root, true)?)?;
        assert_eq!(skipped["applied"], 0); // a's hard link is unsafe too
        std::fs::remove_file(root.join(format!("{}.bin", "d".repeat(64))))?;
        let applied: Value = serde_json::from_str(&maintain(&root, true)?)?;
        assert_eq!(applied["applied"], 1);
        assert_eq!(std::fs::read(&path)?, b"CURSREXP");
        assert_eq!(
            std::fs::read(root.join(format!("{corrupt}.bin")))?,
            corrupt_bytes
        );
        let reopened = Journal::open(&root, &old.scope)?;
        assert!(reopened.load(old.binding).is_err());
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn concurrent_quota_lock_creation_uses_one_inode() -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("private");
        let dir = private_fs::directory(&root)?;
        let barrier = Arc::new(std::sync::Barrier::new(16));
        let mut writers = Vec::new();
        for _ in 0..16 {
            let dir = dir.try_clone()?;
            let barrier = barrier.clone();
            writers.push(std::thread::spawn(move || -> Result<u64> {
                barrier.wait();
                let lock = private_fs::quota_lock(&dir)?;
                Ok(lock.metadata()?.ino())
            }));
        }
        // Join everyone before propagating errors or dropping the fixture.
        let results = writers
            .into_iter()
            .map(|writer| {
                writer
                    .join()
                    .map_err(|_| anyhow!("quota writer panic"))
                    .and_then(|r| r)
            })
            .collect::<Vec<_>>();
        let inode = std::fs::metadata(root.join(".cache-quota.lock"))?.ino();
        for result in results {
            assert_eq!(result?, inode);
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn quota_counts_committed_bytes_and_admission_is_bounded() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("private");
        let journal = Journal::open(&root, &record().scope)?;
        journal.save(&record())?;
        let dir = private_fs::directory(&root)?;
        let quota = private_fs::lock(&dir, ".cache-quota")?;
        assert!(journal
            .save(&record())
            .expect_err("held quota")
            .is::<RootBusy>());
        drop(quota);
        journal.save(&record())?;
        for n in 0..6 {
            let name = format!("{n:064x}.bin");
            private_fs::create(&dir, &name)?.set_len(MAX_RECORD)?;
        }
        // Existing shrinking replacement is permitted to reduce over-quota roots.
        let mut larger = record();
        larger.checkpoint = vec![1; 1024];
        assert!(journal.save(&larger).is_err());
        assert!(journal.load(record().binding)?.is_some());
        let new_scope = "e".repeat(64);
        let other = Journal::open(&root, &new_scope)?;
        assert!(other.save(&Record::new(new_scope, [7; 32])).is_err());
        assert!(!root.join(ROOT_TEMP).exists());
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn dry_run_preserves_inventory_permissions_and_missing_roots() -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        type Inventory = Vec<(String, u32, i64, i64, u64)>;
        fn inventory(root: &Path) -> Result<Inventory> {
            let mut entries = vec![(String::new(), std::fs::metadata(root)?)];
            for entry in std::fs::read_dir(root)? {
                let entry = entry?;
                entries.push((
                    entry.file_name().to_string_lossy().into_owned(),
                    entry.metadata()?,
                ));
            }
            let mut result = entries
                .into_iter()
                .map(|(name, m)| (name, m.mode(), m.mtime(), m.mtime_nsec(), m.len()))
                .collect::<Vec<_>>();
            result.sort();
            Ok(result)
        }
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("private");
        assert!(maintain(&root, false).is_err());
        assert!(!root.exists());
        let mut old = record();
        old.updated = now() - TTL - 1;
        let j = Journal::open(&root, &old.scope)?;
        j.save(&old)?;
        drop(j);
        // Valid orphan and corrupt file both lack lock files.
        let orphan = "e".repeat(64);
        let corrupt = "f".repeat(64);
        let dir = private_fs::existing_directory(&root)?;
        let mut orphan_record = record();
        orphan_record.scope = orphan.clone();
        orphan_record.updated = old.updated;
        encode(
            private_fs::create(&dir, &format!("{orphan}.bin"))?,
            &orphan_record,
        )?;
        private_fs::create(&dir, &format!("{corrupt}.bin"))?.write_all(b"corrupt")?;
        let before = inventory(&root)?;
        let dry: Value = serde_json::from_str(&maintain(&root, false)?)?;
        assert_eq!(dry["expired"], 1);
        assert_eq!(dry["skipped"], 2);
        assert_eq!(inventory(&root)?, before);
        let applied: Value = serde_json::from_str(&maintain(&root, true)?)?;
        assert_eq!(applied["applied"], 1);
        assert!(!root.join(format!("{orphan}.lock")).exists());
        assert!(!root.join(format!("{corrupt}.lock")).exists());
        assert_ne!(
            std::fs::read(root.join(format!("{orphan}.bin")))?,
            b"CURSREXP"
        );
        Ok(())
    }

    #[test]
    fn raw_checkpoint_pending_and_results_round_trip() -> Result<()> {
        let mut r = record();
        r.checkpoint = vec![0xa2, 6, 3, 1, 2, 3];
        r.pending.insert(
            "call".into(),
            Pending {
                tool: tool(),
                exposed: true,
            },
        );
        r.blobs.insert("aabb".into(), vec![9, 8]);
        let mut bytes = Vec::new();
        encode(&mut bytes, &r)?;
        let loaded = decode(bytes.as_slice(), [7; 32])?;
        assert_eq!(loaded.checkpoint, r.checkpoint);
        assert_eq!(loaded.pending["call"].tool.exec_message_id, 9);
        let mut done = loaded;
        done.pending.clear();
        done.completed.insert(
            "call".into(),
            Completed {
                tool: tool(),
                output: json!({"type":"text","value":"already performed"}),
            },
        );
        bytes.clear();
        encode(&mut bytes, &done)?;
        assert_eq!(
            decode(bytes.as_slice(), [7; 32])?.completed["call"].output,
            done.completed["call"].output
        );
        Ok(())
    }
    #[test]
    fn bounded_lineage_round_trips_and_v2_journals_keep_action_fences() -> Result<()> {
        let mut r = record();
        r.in_flight = true;
        r.had_actions = true;
        r.checkpoint = vec![0x50, 0x01];
        r.pending.insert(
            "call".into(),
            Pending {
                tool: tool(),
                exposed: true,
            },
        );
        r.lineage = Some(Lineage {
            history: vec![
                HistoryItem {
                    kind: 1,
                    digest: [4; 32],
                },
                HistoryItem {
                    kind: 4,
                    digest: [5; 32],
                },
            ],
            configuration: [3; 32],
            output_pending: true,
            awaiting_results: false,
            tainted: true,
        });
        let mut bytes = Vec::new();
        encode(&mut bytes, &r)?;
        let loaded = decode(bytes.as_slice(), r.binding)?;
        let lineage = loaded.lineage.as_ref().expect("lineage");
        assert_eq!(
            lineage.history,
            r.lineage.as_ref().expect("lineage").history
        );
        assert_eq!(lineage.configuration, [3; 32]);
        assert!(lineage.output_pending && lineage.tainted && !lineage.awaiting_results);
        // An exact old format, not a v3 record with the optional field absent.
        bytes.clear();
        encode_version(&mut bytes, &r, true)?;
        assert_eq!(&bytes[..8], LEGACY_MAGIC);
        let legacy = decode(bytes.as_slice(), r.binding)?;
        assert!(legacy.lineage.is_none());
        assert!(legacy.in_flight && legacy.had_actions && legacy.pending["call"].exposed);
        assert_eq!(legacy.checkpoint, r.checkpoint);
        let mut oversized = r.clone();
        oversized.lineage.as_mut().expect("lineage").history = vec![
            HistoryItem {
                kind: 1,
                digest: [0; 32]
            };
            MAX_HISTORY + 1
        ];
        assert!(oversized.validate().is_err());
        let mut invalid = r;
        invalid.lineage.as_mut().expect("lineage").history[0].kind = 6;
        assert!(invalid.validate().is_err());
        Ok(())
    }
    #[test]
    fn corruption_expiry_binding_and_oversize_are_rejected() -> Result<()> {
        let mut bytes = Vec::new();
        encode(&mut bytes, &record())?;
        assert!(decode(bytes.as_slice(), [8; 32]).is_err());
        for n in 0..bytes.len() {
            assert!(decode(&bytes[..n], [7; 32]).is_err());
        }
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(decode(bytes.as_slice(), [7; 32]).is_err());
        let mut old = record();
        old.updated = now() - TTL - 1;
        bytes.clear();
        encode(&mut bytes, &old)?;
        assert!(decode(bytes.as_slice(), [7; 32]).is_err());
        let mut oversized = Vec::from(MAGIC.as_slice());
        oversized.extend(u32::MAX.to_le_bytes());
        assert!(decode(oversized.as_slice(), [7; 32]).is_err());
        let mut invalid = record();
        invalid.pending.insert(
            "wrong-id".into(),
            Pending {
                tool: tool(),
                exposed: true,
            },
        );
        assert!(invalid.validate().is_err());
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn expired_payload_becomes_fail_closed_tombstone_and_staging_is_bounded() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("private");
        let mut r = record();
        r.updated = now() - TTL - 1;
        let j = Journal::open(&root, &r.scope)?;
        j.save(&r)?;
        assert!(j.load([7; 32]).is_err());
        let path = root.join(format!("{}.bin", r.scope));
        assert_eq!(std::fs::read(path)?, b"CURSREXP");
        assert!(j.load([7; 32]).is_err());
        drop(j);
        let temporary = root.join(format!(".{}.tmp", r.scope));
        std::fs::write(&temporary, b"abandoned")?;
        let _j = Journal::open(&root, &r.scope)?;
        assert!(!temporary.exists());
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn removal_serializes_with_late_actor_commits_without_resurrection() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("recovery");
        let r = record();
        let journal = Journal::open(&root, &r.scope)?;
        journal.save(&r)?;
        let late = journal.clone();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let writer_barrier = barrier.clone();
        let pending = r.clone();
        let writer = std::thread::spawn(move || {
            writer_barrier.wait();
            for _ in 0..16 {
                // Either a commit wins the mutex first, or observes removal.
                let _ = late.save(&pending);
            }
            late
        });
        barrier.wait();
        journal.remove()?;
        let late = writer.join().map_err(|_| anyhow!("Writer panicked"))?;
        assert!(!root.join(format!("{}.bin", r.scope)).exists());
        assert!(late.save(&r).is_err());
        assert!(late.load(r.binding).is_err());
        journal.remove()?; // Same known journal handle remains idempotent.
        drop(late);
        drop(journal);
        let fresh = Journal::open(&root, &r.scope)?;
        assert!(fresh.load(r.binding)?.is_none());
        fresh.save(&r)?;
        assert!(fresh.load(r.binding)?.is_some());
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn private_atomic_files_locks_and_symlinks() -> Result<()> {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let tmp = tempfile::tempdir()?;
        let base = tmp.path().canonicalize()?;
        let root = base.join("private");
        let r = record();
        let j = Journal::open(&root, &r.scope)?;
        j.save(&r)?;
        let path = root.join(format!("{}.bin", r.scope));
        assert_eq!(
            std::fs::metadata(&path)?.permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&root)?.permissions().mode() & 0o777,
            0o700
        );
        assert!(Journal::open(&root, &r.scope).is_err());
        assert!(j.load([7; 32])?.is_some());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))?;
        assert!(j.load([7; 32]).is_err());
        std::fs::remove_file(&path)?;
        symlink(base.join("outside"), &path)?;
        assert!(j.load([7; 32]).is_err());
        j.remove()?;
        assert!(j.save(&r).is_err());
        symlink(&root, base.join("link"))?;
        assert!(Journal::open(&base.join("link"), &r.scope).is_err());
        Ok(())
    }
    #[test]
    fn capacity_codes_are_distinct_from_corruption_or_uncertainty() {
        for code in CAPACITY_CODES {
            assert_eq!(capacity_code(&anyhow!(code)), Some(code));
        }
        assert_eq!(capacity_code(&RootBusy.into()), Some("cache_root_busy"));
        assert_eq!(capacity_code(&anyhow!("Journal checksum mismatch")), None);
        assert_eq!(
            capacity_code(&anyhow!("cache_quota_exceeded").context("wrapped")),
            None
        );
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn size_only_admission_pass_matches_committed_bytes() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("private");
        let mut r = record();
        r.checkpoint = vec![3; 1000];
        r.blobs.insert("ab".repeat(32), vec![5; 4096]);
        r.pending.insert(
            "call".into(),
            Pending {
                tool: tool(),
                exposed: false,
            },
        );
        let mut done = tool();
        done.tool_call_id = "done".into();
        r.completed.insert(
            "done".into(),
            Completed {
                tool: done,
                output: json!({"ok": true}),
            },
        );
        r.lineage = Some(Lineage {
            history: vec![HistoryItem {
                kind: 1,
                digest: [9; 32],
            }],
            configuration: [4; 32],
            output_pending: true,
            awaiting_results: false,
            tainted: false,
        });
        let journal = Journal::open(&root, &r.scope)?;
        journal.save(&r)?;
        let mut bytes = Vec::new();
        encode(&mut bytes, &r)?;
        // Quota admission must charge exactly what the checksummed commit writes.
        assert_eq!(encoded_size(&r)?, bytes.len() as u64);
        assert_eq!(std::fs::read(root.join(format!("{}.bin", r.scope)))?, bytes);
        assert!(journal.load(r.binding)?.is_some());
        // Other tests commit concurrently; only presence of the numeric snapshot is stable.
        assert!(observed_usage().is_some());
        Ok(())
    }
}
