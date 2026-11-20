//! Shared by all engines in this loaded core (not across independently loaded DSOs).
//! This is payload accounting, NOT an RSS limit: host JSON, prost/JSON object overhead,
//! allocator slack, TLS/h2 internals and runtime stacks are not fully accounted.
use std::sync::atomic::{AtomicUsize, Ordering};

pub const DEFAULT_LIMIT: usize = 512 * 1024 * 1024;
static SHARED: Budget = Budget::new(DEFAULT_LIMIT);

#[derive(Debug)]
pub struct Exhausted;
impl std::fmt::Display for Exhausted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("resource_budget_exhausted")
    }
}
impl std::error::Error for Exhausted {}

#[derive(Debug)]
struct Budget {
    limit: usize,
    used: AtomicUsize,
    peak: AtomicUsize,
    denied: AtomicUsize,
}
impl Budget {
    const fn new(limit: usize) -> Self {
        Self {
            limit,
            used: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            denied: AtomicUsize::new(0),
        }
    }
    fn acquire(&self, bytes: usize) -> Result<(), Exhausted> {
        #[allow(deprecated)] // Keep compatibility with the workspace MSRV.
        let result = self
            .used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|next| *next <= self.limit)
            });
        match result {
            Ok(before) => {
                self.peak.fetch_max(before + bytes, Ordering::Relaxed);
                Ok(())
            }
            Err(_) => {
                self.denied.fetch_add(1, Ordering::Relaxed);
                Err(Exhausted)
            }
        }
    }
}

#[derive(Debug)]
pub struct Lease {
    bytes: usize,
    budget: &'static Budget,
}
impl Default for Lease {
    fn default() -> Self {
        Self {
            bytes: 0,
            budget: &SHARED,
        }
    }
}
impl Lease {
    pub fn reserve(bytes: usize) -> Result<Self, Exhausted> {
        SHARED.acquire(bytes)?;
        Ok(Self {
            bytes,
            budget: &SHARED,
        })
    }
    #[cfg(test)]
    pub(crate) fn isolated_for_test(limit: usize) -> Self {
        Self {
            bytes: 0,
            budget: Box::leak(Box::new(Budget::new(limit))),
        }
    }
    #[cfg(test)]
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn resize(&mut self, bytes: usize) -> Result<(), Exhausted> {
        if bytes > self.bytes {
            self.budget.acquire(bytes - self.bytes)?;
        } else {
            self.budget
                .used
                .fetch_sub(self.bytes - bytes, Ordering::AcqRel);
        }
        self.bytes = bytes;
        Ok(())
    }
    /// Release headroom once speculative work is done; never acquires more.
    pub fn shrink_to(&mut self, bytes: usize) {
        if bytes < self.bytes {
            self.budget
                .used
                .fetch_sub(self.bytes - bytes, Ordering::AcqRel);
            self.bytes = bytes;
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

/// A queue lease stays alive through the consumer's processing, not merely recv().
#[derive(Debug)]
pub struct Payload {
    pub(crate) bytes: Vec<u8>,
    pub(crate) lease: Lease,
}
impl Payload {
    pub fn from_vec(bytes: Vec<u8>) -> Result<Self, Exhausted> {
        let lease = Lease::reserve(bytes.capacity())?;
        Ok(Self { bytes, lease })
    }
}
impl std::ops::Deref for Payload {
    type Target = Vec<u8>;
    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
}
impl<T: AsRef<[u8]> + ?Sized> PartialEq<T> for Payload {
    fn eq(&self, rhs: &T) -> bool {
        self.bytes.as_slice() == rhs.as_ref()
    }
}

/// Payload only; allocator/container overhead is outside the documented contract.
pub(crate) fn value_bytes(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::String(s) => s.capacity(),
        serde_json::Value::Array(a) => a.iter().map(value_bytes).sum(),
        serde_json::Value::Object(o) => o.iter().map(|(k, v)| k.capacity() + value_bytes(v)).sum(),
        _ => 0,
    }
}

pub fn stats() -> String {
    let mut stats = serde_json::json!({"code":"payload_accounting", "limitBytes":SHARED.limit,
        "trackedBytes":SHARED.used.load(Ordering::Relaxed), "peakBytes":SHARED.peak.load(Ordering::Relaxed),
        "exhaustions":SHARED.denied.load(Ordering::Relaxed), "rssBounded":false,
        "cacheLimitBytes":1073741824u64,"cacheLimitEntries":4096,"cacheTemporaryLimitBytes":209715200u64,
        "cacheScanLimitEntries":16384});
    // Observed at the latest commit admission; stats themselves never touch the filesystem.
    if let (Some(usage), Some(object)) = (crate::journal::observed_usage(), stats.as_object_mut()) {
        object.insert("cacheCommittedBytes".into(), usage.bytes.into());
        object.insert("cacheRecords".into(), usage.records.into());
        object.insert("cacheDirectoryEntries".into(), usage.entries.into());
    }
    stats.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queue_and_consumer_keep_lease_until_drop_without_global_test_configuration() {
        let budget = Box::leak(Box::new(Budget::new(100)));
        let mut lease = Lease { bytes: 0, budget };
        lease.resize(64).expect("admitted");
        assert!(lease.resize(101).is_err());
        assert_eq!(budget.used.load(Ordering::Acquire), 64);
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tx.send(Payload {
            bytes: vec![0; 64],
            lease,
        })
        .await
        .expect("queue");
        assert_eq!(budget.used.load(Ordering::Acquire), 64);
        let processing = rx.recv().await.expect("payload");
        assert_eq!(budget.used.load(Ordering::Acquire), 64);
        drop(processing);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
    }
    #[test]
    fn shrink_releases_headroom_but_never_acquires() {
        let budget = Box::leak(Box::new(Budget::new(100)));
        let mut lease = Lease { bytes: 0, budget };
        lease.resize(80).expect("admitted");
        lease.shrink_to(90);
        assert_eq!(budget.used.load(Ordering::Acquire), 80);
        lease.shrink_to(5);
        assert_eq!(budget.used.load(Ordering::Acquire), 5);
        drop(lease);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
    }
    #[test]
    fn bounded_atomic_fail_fast_and_overflow() {
        let b = Budget::new(10);
        assert!(b.acquire(7).is_ok());
        assert!(b.acquire(4).is_err());
        assert!(b.acquire(usize::MAX).is_err());
        assert_eq!(b.used.load(Ordering::Relaxed), 7);
        b.used.fetch_sub(7, Ordering::AcqRel);
        assert!(b.acquire(10).is_ok());
        assert_eq!(b.peak.load(Ordering::Relaxed), 10);
    }
}
