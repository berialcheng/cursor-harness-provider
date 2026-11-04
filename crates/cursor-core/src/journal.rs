//! Private, bounded recovery records. No credentials, host transcript, or tool registry.
//! Checkpoints are opaque bytes: decoding/re-encoding them would discard future fields.
use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::{Read, Write},
    path::{Component, Path},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, ensure, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::types::PendingTool;

pub(crate) const MAX_BLOBS: usize = 512;
pub(crate) const MAX_BLOB: usize = 32 * 1024 * 1024;
pub(crate) const MAX_STORE: usize = 128 * 1024 * 1024;
const MAX_TOOLS: usize = 512;
const MAX_INPUT: usize = 1024 * 1024;
const MAX_RESULT: usize = 16 * 1024 * 1024;
const MAX_RESULTS: usize = 32 * 1024 * 1024;
const MAX_RECORD: u64 = (MAX_STORE + MAX_BLOB + MAX_RESULTS + 8 * 1024 * 1024) as u64;
const MAGIC: &[u8; 8] = b"CURSRJ02";
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
        }
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
            fd::{AsRawFd, FromRawFd},
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
        ensure!(fd >= 0, "Cannot safely open private journal entry");
        // SAFETY: successful openat returns an owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub fn directory(path: &Path) -> Result<File> {
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
                    if unsafe { mkdirat(dir.as_raw_fd(), part.as_ptr(), 0o700) } == 0 {
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
    pub fn lock(dir: &File, scope: &str) -> Result<File> {
        let file = open(
            dir,
            &name(format!("{scope}.lock").as_bytes())?,
            2 | FLAGS.1 | FLAGS.2 | FLAGS.3 | FLAGS.5,
        )?;
        check(&file, false)?;
        ensure!(
            unsafe { flock(file.as_raw_fd(), 2 | 4) } == 0,
            "Scope journal is already in use"
        );
        Ok(file)
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
        ensure!(
            file.metadata()?.len() <= MAX_RECORD,
            "Journal file exceeds size limit"
        );
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

#[derive(Clone)]
pub(crate) struct Journal(Arc<JournalInner>);
struct JournalInner {
    dir: File,
    _lock: File,
    entry: String,
    temporary: String,
    // Also serializes remove against a final atomic commit. No late resurrection.
    enabled: Mutex<bool>,
}
impl Journal {
    pub fn open(path: &Path, scope: &str) -> Result<Self> {
        validate_scope(scope)?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let dir = private_fs::directory(path)?;
            let lock = private_fs::lock(&dir, scope)?;
            // One deterministic staging file per locked scope; a crash cannot
            // accumulate a fresh 200 MiB temporary file on every attempted save.
            let temporary = format!(".{scope}.tmp");
            private_fs::remove(&dir, &temporary)?;
            Ok(Self(Arc::new(JournalInner {
                dir,
                _lock: lock,
                entry: format!("{scope}.bin"),
                temporary,
                enabled: Mutex::new(true),
            })))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = path;
            bail!("Private recovery journals require Linux or macOS descriptor-relative filesystem support")
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
        let result = decode(file, binding);
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e.to_string() == "Journal expired")
        {
            // On access, discard expired payloads but retain a non-sensitive
            // tombstone: treating expiration as an empty/new scope could repeat
            // an action whose result is now unavailable. Explicit remove resets it.
            self.replace(|file| {
                file.write_all(b"CURSREXP")?;
                Ok(())
            })?;
        }
        result.map(Some).map_err(|_| anyhow!("Recovery journal is expired, corrupt, oversized, or has a different binding; explicitly remove the scope to discard it"))
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
        self.replace(|file| encode(file, record))
    }
    fn replace(&self, write: impl FnOnce(&mut File) -> Result<()>) -> Result<()> {
        let result = (|| {
            let mut file = private_fs::create(&self.0.dir, &self.0.temporary)?;
            write(&mut file)?;
            file.sync_all()?;
            private_fs::rename(&self.0.dir, &self.0.temporary, &self.0.entry)
        })();
        if result.is_err() {
            let _ = private_fs::remove(&self.0.dir, &self.0.temporary);
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
        *enabled = false;
        private_fs::remove(&self.0.dir, &self.0.entry)
    }
}

struct Encoder<W> {
    io: W,
    digest: Sha256,
    bytes: u64,
}
impl<W: Write> Encoder<W> {
    fn raw(&mut self, bytes: &[u8]) -> Result<()> {
        self.bytes += bytes.len() as u64;
        ensure!(self.bytes + 32 <= MAX_RECORD, "Journal size limit exceeded");
        self.io.write_all(bytes)?;
        self.digest.update(bytes);
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
    let mut e = Encoder {
        io: writer,
        digest: Sha256::new(),
        bytes: 0,
    };
    e.raw(MAGIC)?;
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
    e.io.write_all(&e.digest.finalize())?;
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
    let mut d = Decoder {
        io: reader,
        digest: Sha256::new(),
        remaining: MAX_RECORD as usize - 32,
    };
    let mut magic = [0; 8];
    d.raw(&mut magic)?;
    ensure!(&magic == MAGIC, "Invalid journal version");
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
        updated <= now().saturating_add(60) && now().saturating_sub(updated) <= TTL,
        "Journal expired"
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
    let mut checksum = [0; 32];
    d.io.read_exact(&mut checksum)?;
    ensure!(
        checksum.as_slice() == d.digest.finalize().as_slice(),
        "Journal checksum mismatch"
    );
    ensure!(d.io.read(&mut [0])? == 0, "Trailing journal data");
    r.validate()?;
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
}
