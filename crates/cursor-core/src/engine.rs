//! Session ownership and conservative recovery. The host, never this process,
//! executes tools. An interrupted action turn may replay known result identities,
//! but cannot introduce another unknown host action until TurnEnded is observed.
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, bail, ensure, Result};
use prost::Message;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{
    sync::mpsc,
    time::{self, Instant},
};
use tokio_util::sync::CancellationToken;

use crate::{
    journal::{self, Completed, HistoryItem, Journal, Lineage, Pending, Record},
    pb, protocol,
    resource::{self, Lease as ByteLease},
    sha256::Sha256,
    transport::{self, Client, Connection, Frame},
    types::{validate_model_parameters, PendingTool, ServerAction, StartInput, WireContext},
};

const MAX_SESSIONS: usize = 64;
// Paths/bindings only: retired actors must not retain journal FDs or action
// ledgers in memory. Eviction never deletes a journal; an unknown reset fails.
const MAX_RETIRED: usize = 256;
const PARK_TTL: Duration = Duration::from_secs(60 * 60);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(30);
const RUN_PATH: &str = "/agent.v1.AgentService/Run";
const METADATA_TIMEOUT_MS: u64 = 5_000;
const SYSTEM: u8 = 0;
const USER: u8 = 1;
const TEXT: u8 = 2;
const REASONING: u8 = 3;
const CALL: u8 = 4;
const RESULT: u8 = 5;
const MAX_HISTORY_BYTES: usize = 128 * 1024 * 1024;
const MAX_DEFERRED_FRAMES: usize = 8;
const MAX_DEFERRED_REPLY_BYTES: usize = 1024 * 1024;
const MAX_DEFERRED_AGE: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}
struct Inner {
    client: Client,
    stop: CancellationToken,
    slots: Mutex<HashMap<String, Slot>>,
    retired: Mutex<HashMap<String, RecoveryLocation>>,
}
#[derive(Clone)]
struct RecoveryLocation {
    binding: [u8; 32],
    root: Option<PathBuf>,
}
fn remember_retired(
    retired: &mut HashMap<String, RecoveryLocation>,
    scope: String,
    location: RecoveryLocation,
) {
    if !retired.contains_key(&scope) && retired.len() >= MAX_RETIRED {
        // No FDs or ledger deletion, even when a location must be forgotten.
        if let Some(key) = retired.keys().next().cloned() {
            retired.remove(&key);
        }
    }
    retired.insert(scope, location);
}
struct Slot {
    binding: [u8; 32],
    root: Option<PathBuf>,
    journal: Option<Journal>,
    busy: Arc<AtomicBool>,
    stop: CancellationToken,
    jobs: mpsc::Sender<Job>,
}
struct Control {
    cancel: CancellationToken,
    done: CancellationToken,
    finished: AtomicBool,
    refreshing: AtomicBool,
    busy: Arc<AtomicBool>,
}
impl Control {
    fn complete(&self) {
        // Publish before the finish event: ordinary host post-finish cleanup
        // must not cancel an RPC which is now parked on a host tool result.
        if !self.finished.swap(true, Ordering::AcqRel) {
            self.busy.store(false, Ordering::Release);
            self.done.cancel();
        }
    }
}
struct Lease(Arc<Control>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.complete();
    }
}

pub struct RunningStream {
    events: tokio::sync::Mutex<mpsc::Receiver<QueuedEvent>>,
    control: Arc<Control>,
    refresh: mpsc::Sender<String>,
}
impl RunningStream {
    pub async fn next(&self) -> Option<Value> {
        self.events
            .lock()
            .await
            .recv()
            .await
            .map(|event| event.value)
    }
    /// N-API consumes/serializes while the queue lease is still held.
    pub async fn next_json(&self) -> Option<Result<String>> {
        let event = self.events.lock().await.recv().await?;
        Some((|| {
            let _serialization = ByteLease::reserve(event.bytes)?;
            Ok(serde_json::to_string(&event.value)?)
        })())
    }
    pub fn cancel(&self) {
        if !self.control.finished.load(Ordering::Acquire) {
            self.control.cancel.cancel();
            if let Ok(mut events) = self.events.try_lock() {
                while events.try_recv().is_ok() {} // release queued payload leases promptly
            }
            // The actor remains serial even if a bounded filesystem commit is
            // still finishing. Cancelled host requests need not retain the lease.
            self.control.complete();
        }
    }
    pub async fn set_access_token(&self, token: String) -> Result<()> {
        validate_token(&token)?;
        ensure!(
            !self.control.finished.load(Ordering::Acquire)
                && self.control.refreshing.load(Ordering::Acquire),
            "No token refresh is pending for this stream"
        );
        self.refresh
            .try_send(token)
            .map_err(|_| anyhow!("Token refresh is no longer pending"))
    }
}
impl Drop for RunningStream {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct Job {
    input: StartInput,
    token: String,
    results: HashMap<String, Value>,
    output: Output,
    refresh: mpsc::Receiver<String>,
    _lease: Lease,
}
impl Engine {
    pub fn new() -> Result<Self> {
        Ok(Self {
            inner: Arc::new(Inner {
                client: transport::client()?,
                stop: CancellationToken::new(),
                slots: Mutex::new(HashMap::new()),
                retired: Mutex::new(HashMap::new()),
            }),
        })
    }
    pub async fn start(&self, input: StartInput, access_token: String) -> Result<RunningStream> {
        validate_input(&input)?;
        validate_token(&access_token)?;
        ensure!(
            !self.inner.stop.is_cancelled(),
            "Cursor engine is shut down"
        );
        let route = agent_url(input.agent_url.as_deref())?;
        let binding = binding(&input, &route);
        let root = if input.stateless {
            None
        } else {
            Some(cache_root(input.cache_dir.as_deref())?)
        };
        let results = protocol::parse_tool_results(&input)
            .map_err(|_| anyhow!("Invalid or conflicting host tool results"))?;
        let mut slots = self
            .inner
            .slots
            .lock()
            .map_err(|_| anyhow!("Session registry lock failed"))?;
        // Always acquire registry locks in this order, including remove().
        let mut retired = self
            .inner
            .retired
            .lock()
            .map_err(|_| anyhow!("Recovery location registry lock failed"))?;
        // Shutdown can win while validation or registry admission is waiting.
        // Recheck under the same locks as shutdown before creating journal files.
        ensure!(
            !self.inner.stop.is_cancelled(),
            "Cursor engine is shut down"
        );
        if let Some(location) = retired.get(&input.scope) {
            ensure!(
                location.binding == binding && location.root == root,
                "Retired scope binding or recovery location changed; explicitly remove the scope"
            );
        }
        if let Some(slot) = slots.get(&input.scope) {
            ensure!(
                slot.binding == binding && slot.root == root,
                "Scope binding, route, workspace, model, or persistence mode changed"
            );
            ensure!(
                !slot.busy.load(Ordering::Acquire),
                "A request is already active for this scope"
            );
        }
        let closed = slots.get(&input.scope).is_none_or(|s| s.jobs.is_closed());
        if closed {
            // PARK_TTL closes the actor's receiver, not its registry entry.
            // Reclaim only dead, idle actors; live tool parks and busy leases
            // must retain their context. Durable journals are never removed.
            // Keep the requested slot so its binding/custom journal is reused.
            slots.retain(|scope, slot| {
                let keep = scope == &input.scope
                    || !slot.jobs.is_closed()
                    || slot.busy.load(Ordering::Acquire);
                if !keep {
                    remember_retired(
                        &mut retired,
                        scope.clone(),
                        RecoveryLocation {
                            binding: slot.binding,
                            root: slot.root.clone(),
                        },
                    );
                }
                keep
            });
            ensure!(
                slots.contains_key(&input.scope) || slots.len() < MAX_SESSIONS,
                "Cursor session limit reached (64); remove an unused scope"
            );
            let journal = match slots.get(&input.scope) {
                Some(old) => old.journal.clone(),
                None => root
                    .as_ref()
                    .map(|r| Journal::open(r, &input.scope))
                    .transpose()?,
            };
            let record = match journal.as_ref().map(|j| j.load(binding)).transpose() {
                Ok(record) => record
                    .flatten()
                    .unwrap_or_else(|| Record::new(input.scope.clone(), binding)),
                Err(error) => {
                    // Remember a safely opened custom root even when its record
                    // is corrupt/expired, so remove(scope) can actually clear it.
                    let (jobs, rx) = mpsc::channel(1);
                    drop(rx);
                    slots.insert(
                        input.scope.clone(),
                        Slot {
                            binding,
                            root,
                            journal,
                            busy: Arc::new(AtomicBool::new(false)),
                            stop: self.inner.stop.child_token(),
                            jobs,
                        },
                    );
                    return Err(error);
                }
            };
            ensure!(record.scope == input.scope, "Journal scope mismatch");
            let stop = self.inner.stop.child_token();
            let busy = Arc::new(AtomicBool::new(false));
            let (tx, rx) = mpsc::channel(1);
            let session = Session::new(
                record,
                journal.clone(),
                route,
                self.inner.client.clone(),
                stop.clone(),
                input.stateless,
            )?;
            tokio::spawn(session.run(rx));
            slots.insert(
                input.scope.clone(),
                Slot {
                    binding,
                    root,
                    journal,
                    busy,
                    stop,
                    jobs: tx,
                },
            );
        }
        retired.remove(&input.scope);
        let slot = slots
            .get(&input.scope)
            .ok_or_else(|| anyhow!("Session unavailable"))?;
        ensure!(
            slot.busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "A request is already active for this scope"
        );
        let control = Arc::new(Control {
            cancel: CancellationToken::new(),
            done: CancellationToken::new(),
            finished: AtomicBool::new(false),
            refreshing: AtomicBool::new(false),
            busy: slot.busy.clone(),
        });
        let (tx, rx) = mpsc::channel(32);
        let (refresh, updates) = mpsc::channel(1);
        let output = Output {
            tx,
            control: control.clone(),
            stop: slot.stop.clone(),
            block: None,
            sequence: 0,
            exposed: false,
            accepted: false,
        };
        let job = Job {
            input,
            token: access_token,
            results,
            output,
            refresh: updates,
            _lease: Lease(control.clone()),
        };
        slot.jobs
            .try_send(job)
            .map_err(|_| anyhow!("Session worker is unavailable"))?;
        Ok(RunningStream {
            events: tokio::sync::Mutex::new(rx),
            control,
            refresh,
        })
    }
    /// Cheap atomic payload counters; deliberately no filesystem or authentication work.
    pub fn resource_stats(&self) -> String {
        resource::stats()
    }
    pub async fn maintain_cache(&self, scope: &str, apply: bool) -> Result<String> {
        journal::validate_scope(scope)?;
        let root = {
            let slots = self
                .inner
                .slots
                .lock()
                .map_err(|_| anyhow!("cache_registry_unavailable"))?;
            let retired = self
                .inner
                .retired
                .lock()
                .map_err(|_| anyhow!("cache_registry_unavailable"))?;
            slots
                .get(scope)
                .map(|slot| slot.root.clone())
                .or_else(|| retired.get(scope).map(|location| location.root.clone()))
                .ok_or_else(|| anyhow!("cache_unknown_scope"))?
                .ok_or_else(|| anyhow!("cache_stateless_scope"))?
        };
        tokio::task::spawn_blocking(move || journal::maintain(&root, apply))
            .await
            .map_err(|_| anyhow!("cache_maintenance_unavailable"))?
            .map_err(|_| anyhow!("cache_maintenance_failed"))
    }
    pub async fn models(&self, access_token: String, url: Option<String>) -> Result<Value> {
        validate_token(&access_token)?;
        ensure!(
            !self.inner.stop.is_cancelled(),
            "Cursor engine is shut down"
        );
        let route = agent_url(url.as_deref())?;
        // AvailableModels is optional metadata, not evidence that guessed
        // parameter combinations or image capabilities are supported. Fixtures
        // keep both unary services on their explicitly selected loopback origin.
        let metadata_route = if loopback_origin(&route) {
            route.as_str()
        } else {
            "https://api2.cursor.sh"
        };
        let (path, request) = protocol::model_list_request();
        let (metadata_path, metadata_request) = protocol::available_models_request();
        // Overlap both origins' handshakes. A failed base list returns at once and drops the
        // metadata request; metadata alone never completes or replaces discovery.
        let base_call = transport::unary(
            &self.inner.client,
            &route,
            &path,
            &access_token,
            request,
            30_000,
        );
        let metadata_call = transport::unary(
            &self.inner.client,
            metadata_route,
            &metadata_path,
            &access_token,
            metadata_request,
            METADATA_TIMEOUT_MS,
        );
        tokio::pin!(base_call, metadata_call);
        let mut metadata = None;
        let bytes = loop {
            tokio::select! {
                biased;
                _ = self.inner.stop.cancelled() => bail!("Cursor engine is shut down"),
                result = &mut base_call => break result.map_err(|_| anyhow!("Cursor model discovery failed; check authentication and HTTP/2 connectivity"))?,
                result = &mut metadata_call, if metadata.is_none() => metadata = Some(result),
            }
        };
        let base = protocol::decode_model_list(&bytes)
            .map_err(|_| anyhow!("Invalid Cursor model list"))?;
        let metadata = match metadata {
            Some(result) => result,
            None => tokio::select! {
                biased;
                _ = self.inner.stop.cancelled() => bail!("Cursor engine is shut down"),
                result = &mut metadata_call => result,
            },
        };
        ensure!(
            !self.inner.stop.is_cancelled(),
            "Cursor engine is shut down"
        );
        let models = match metadata {
            Ok(bytes) => protocol::enrich_model_list(base.clone(), &bytes).unwrap_or(base),
            Err(_) => base,
        };
        ensure!(
            !self.inner.stop.is_cancelled(),
            "Cursor engine is shut down"
        );
        Ok(models)
    }
    /// Read-only dashboard period usage. Returns the endpoint's JSON object;
    /// hosts own presentation. No route override, cookies, credential lookup, or retries.
    pub async fn get_usage(&self, access_token: String) -> Result<Value> {
        validate_token(&access_token)?;
        ensure!(
            !self.inner.stop.is_cancelled(),
            "Cursor engine is shut down"
        );
        transport::get_usage(&self.inner.client, &access_token).await
    }
    pub async fn remove(&self, scope: &str) -> Result<()> {
        journal::validate_scope(scope)?;
        let slot = {
            let mut slots = self
                .inner
                .slots
                .lock()
                .map_err(|_| anyhow!("Session registry lock failed"))?;
            let mut retired = self
                .inner
                .retired
                .lock()
                .map_err(|_| anyhow!("Recovery location registry lock failed"))?;
            if let Some(slot) = slots.get(scope) {
                slot.stop.cancel();
                if let Some(journal) = &slot.journal {
                    // Journal::remove serializes against late commits and disables
                    // all actor clones before releasing the registry lock.
                    journal.remove()?;
                }
                retired.remove(scope);
                slots.remove(scope)
            } else {
                let location = retired.get(scope).ok_or_else(|| anyhow!(
                    "Recovery location unknown or forgotten; reset not performed. Start the scope with its original binding and cacheDir before removing it"
                ))?;
                if let Some(root) = &location.root {
                    Journal::open(root, scope)?.remove()?;
                }
                retired.remove(scope);
                None
            }
        };
        if let Some(slot) = slot {
            time::timeout(Duration::from_secs(5), slot.jobs.closed())
                .await
                .map_err(|_| anyhow!("Scope cancellation is pending"))?;
        }
        Ok(())
    }
    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
}
impl Inner {
    fn shutdown(&self) {
        self.stop.cancel();
        self.client.shutdown();
        if let Ok(mut slots) = self.slots.lock() {
            for slot in slots.values() {
                slot.stop.cancel();
            }
            slots.clear();
        }
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RpcDisposition {
    Live,
    Frozen,
}
fn ensure_frozen_kv(raw: &[u8]) -> std::result::Result<(), &'static str> {
    // Called only after protocol::handle_message's oneof and payload validation.
    match pb::AgentServerMessage::decode(raw) {
        Ok(pb::AgentServerMessage {
            message: Some(pb::agent_server_message::Message::KvServerMessage(_)),
            ..
        }) => Ok(()),
        _ => Err("Unexpected reply while draining a frozen RPC"),
    }
}

struct Session {
    record: Record,
    context: WireContext,
    journal: Option<Journal>,
    rpc: Option<Connection>,
    route: String,
    client: Client,
    stop: CancellationToken,
    stateless: bool,
    recovery_fence: bool,
    blocked: bool,
    rejects: u32,
    output_proof: Option<(u8, Sha256)>,
    resident: ByteLease,
    // Set when a commit failed on root capacity; reported instead of a generic failure.
    capacity: Option<&'static str>,
    // Live turns coalesce commits across frames that already arrived: `dirty` state is
    // committed before its `acks` go out, before any wait for another frame, and before
    // tools, TurnEnded or an exit. Parked and frozen RPCs commit every frame.
    deferring: bool,
    dirty: bool,
    acks: Vec<resource::Payload>,
}
impl Session {
    fn new(
        mut record: Record,
        journal: Option<Journal>,
        route: String,
        client: Client,
        stop: CancellationToken,
        stateless: bool,
    ) -> Result<Self> {
        let mut resident = record.take_resident();
        resident.resize(record.resident_bytes())?;
        let context = WireContext {
            blobs: std::mem::take(&mut record.blobs),
            ..Default::default()
        };
        Ok(Self {
            record,
            context,
            journal,
            rpc: None,
            route,
            client,
            stop,
            stateless,
            recovery_fence: false,
            blocked: false,
            rejects: 0,
            output_proof: None,
            resident,
            capacity: None,
            deferring: false,
            dirty: false,
            acks: Vec::new(),
        })
    }
    fn resident_bytes(&self) -> usize {
        self.context
            .blobs
            .values()
            .map(Vec::capacity)
            .sum::<usize>()
            + self.record.resident_bytes()
            + self
                .context
                .tools
                .iter()
                .map(resource::value_bytes)
                .sum::<usize>()
            + self.context.workspace.capacity()
    }
    fn persist(&mut self) -> Result<()> {
        self.record.updated = journal::now();
        // Transfer ownership temporarily, avoiding a second 128 MiB blob copy.
        std::mem::swap(&mut self.context.blobs, &mut self.record.blobs);
        let result = self.record.validate().and_then(|_| {
            self.journal
                .as_ref()
                .map_or(Ok(()), |j| j.save(&self.record))
        });
        std::mem::swap(&mut self.context.blobs, &mut self.record.blobs);
        // Even admission failure leaves pre-persist mutations in memory.
        // Never treat these as retryable without a full precommit rollback.
        if let Err(error) = &result {
            self.blocked = true;
            self.capacity = self.capacity.or(journal::capacity_code(error));
        } else {
            self.dirty = false;
        }
        result
    }
    /// Commit deferred checkpoint/blob state, then acknowledge it in arrival order.
    async fn flush(&mut self, output: Option<&Output>) -> std::result::Result<(), &'static str> {
        if self.dirty {
            self.persist()
                .map_err(|_| "Cannot commit Cursor blob/reply state")?;
        }
        for ack in std::mem::take(&mut self.acks) {
            self.send_payload(ack, output).await.map_err(|error| {
                if error.is::<resource::Exhausted>() {
                    "resource_budget_exhausted"
                } else {
                    "Cursor reply upload failed"
                }
            })?;
        }
        Ok(())
    }
    fn stop_rpc(&mut self) {
        if let Some(rpc) = self.rpc.take() {
            let _ = rpc.outgoing.try_send(protocol::cancel_message());
            rpc.cancel.cancel(); // reset this stream, not the pooled HTTP/2 client
        }
    }
    fn abandon_action_free_turn(&mut self) -> Result<()> {
        // had_actions is committed BEFORE exposing any host call, and survives
        // result reconciliation. Completed identities from earlier turns alone
        // do not mean this turn escaped; never discard either action ledger.
        // Even a staged, unexposed pending call is conservatively retained.
        if !self.record.in_flight || self.record.had_actions || !self.record.pending.is_empty() {
            return Ok(());
        }
        ensure!(!self.blocked, "Cannot abandon uncommitted recovery state");
        self.record.in_flight = false;
        self.record.checkpoint.clear();
        self.record.lineage = None;
        self.output_proof = None;
        self.record.conversation = uuid::Uuid::new_v4().to_string();
        self.context = WireContext::default();
        self.resident.resize(self.resident_bytes())?;
        self.recovery_fence = false;
        self.rejects = 0;
        self.persist()
    }
    async fn run(mut self, mut jobs: mpsc::Receiver<Job>) {
        let mut parked_until = Instant::now() + PARK_TTL;
        loop {
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => break,
                _ = time::sleep_until(parked_until) => break,
                job = jobs.recv() => {
                    let Some(mut job) = job else { break };
                    if let Err(mut message) = self.run_job(&mut job).await {
                        if job.output.accepted || self.blocked { self.stop_rpc(); }
                        if job.output.accepted && self.abandon_action_free_turn().is_err() {
                            message = "Cannot durably abandon Cursor turn; recovery is blocked";
                        }
                        if let Some(code) = self.capacity.take() { message = capacity_message(code); }
                        job.output.error(message).await;
                    }
                    // Lease is released before accepting another start. Heartbeats do
                    // not extend this deadline; an abandoned tool RPC cannot live forever.
                    if job.output.accepted { parked_until = Instant::now() + PARK_TTL; }
                    drop(job);
                }
                frame = async { match self.rpc.as_mut() { Some(rpc) => rpc.incoming.recv().await, None => std::future::pending().await } } => {
                    match frame {
                        Some(Ok(Frame::Message(bytes))) => {
                            if self.actions(&bytes, None).await.is_err() {
                                // A parked peer must not make unaccounted progress.
                                // Keep this fence across process restarts as well.
                                if let Some(lineage) = &mut self.record.lineage { lineage.tainted = true; }
                                let _ = self.persist();
                                self.blocked = true;
                                self.stop_rpc();
                            }
                        }
                        // End, including an empty successful Connect envelope, is NOT
                        // TurnEnded. Keep recovery identities, never synthesize success.
                        _ => self.stop_rpc(),
                    }
                }
            }
        }
        self.stop_rpc();
    }
    fn taint_parked(&mut self) -> anyhow::Error {
        if let Some(lineage) = &mut self.record.lineage {
            lineage.tainted = true;
        }
        let _ = self.persist();
        self.blocked = true;
        self.stop_rpc();
        anyhow!("Unaccounted parked RPC progress; refusing to consume host results")
    }
    async fn drain_parked(&mut self, freeze: bool) -> Result<()> {
        if !freeze && !self.record.had_actions && self.record.pending.is_empty() {
            return Ok(());
        }
        if freeze {
            if let Some(rpc) = &mut self.rpc {
                rpc.incoming.close();
                rpc.cancel.cancel();
            }
        }
        let mut ended = false;
        let mut exhausted = true;
        for _ in 0..64 {
            let next = if let Some(rpc) = &mut self.rpc {
                if freeze {
                    // close() forbids new permits. Await any pre-existing send
                    // permit too, rather than racing a final try_recv(Empty).
                    match time::timeout(Duration::from_secs(1), rpc.incoming.recv()).await {
                        Ok(message) => message,
                        Err(_) => return Err(self.taint_parked()),
                    }
                } else {
                    match rpc.incoming.try_recv() {
                        Ok(message) => Some(message),
                        Err(mpsc::error::TryRecvError::Empty) => {
                            exhausted = false;
                            break;
                        }
                        Err(mpsc::error::TryRecvError::Disconnected) => None,
                    }
                }
            } else {
                return Ok(());
            };
            match next {
                Some(Ok(Frame::Message(bytes))) => {
                    let disposition = if freeze {
                        RpcDisposition::Frozen
                    } else {
                        RpcDisposition::Live
                    };
                    if self
                        .actions_with_disposition(&bytes, None, disposition)
                        .await
                        .is_err()
                    {
                        return Err(self.taint_parked());
                    }
                }
                Some(_) => ended = true,
                None => {
                    ended = true;
                    exhausted = false;
                    break;
                }
            }
        }
        // A continuously flooding parked peer is not a quiescent boundary.
        if exhausted {
            return Err(self.taint_parked());
        }
        if freeze || ended {
            self.stop_rpc();
        }
        Ok(())
    }
    // Validate the entire authoritative history before consuming even one
    // result. Invalid IDs/arguments/outputs leave both the ledger and live park
    // untouched. Changed instructions/registries are never silently dropped.
    async fn reconcile(&mut self, job: &Job) -> Result<Vec<(PendingTool, Value)>> {
        ensure!(
            !self.blocked,
            "Session recovery is blocked; explicitly remove this scope"
        );
        // Jobs win the actor's biased select. Account for already queued peer
        // progress before treating the old RPC as a known-result handoff.
        self.drain_parked(false).await?;
        let proof = transcript_proof(&job.input)?;
        let configuration = configuration(&job.input)?;
        for (id, tool) in &proof.calls {
            let known = self
                .record
                .pending
                .get(id)
                .map(|p| &p.tool)
                .or_else(|| self.record.completed.get(id).map(|c| &c.tool));
            if let Some(known) = known {
                ensure!(
                    same_action(known, tool),
                    "A known host tool ID changed name or arguments"
                );
            }
        }
        for (id, done) in &self.record.completed {
            if let Some(value) = job.results.get(id) {
                ensure!(value == &done.output, "A recorded host result changed");
            }
        }
        for id in job.results.keys() {
            ensure!(
                proof.calls.contains_key(id)
                    || self.record.pending.contains_key(id)
                    || self.record.completed.contains_key(id),
                "A host result has no known assistant call"
            );
        }
        let mut replies = Vec::new();
        for (id, pending) in &self.record.pending {
            ensure!(
                !pending.exposed || job.results.contains_key(id),
                "Matching results for every pending tool-call ID are required"
            );
            if let Some(value) = job.results.get(id) {
                ensure!(
                    pending.exposed,
                    "Host supplied a result for a tool not yet exposed"
                );
                protocol::tool_result(&pending.tool, value)
                    .map_err(|_| anyhow!("Unsupported host tool output"))?;
                replies.push((pending.tool.clone(), value.clone()));
            }
        }
        let complete = proof.calls.keys().all(|id| job.results.contains_key(id))
            && job.results.keys().all(|id| proof.calls.contains_key(id));
        let quiescent = self.record.lineage.as_ref().is_some_and(|lineage| {
            lineage.awaiting_results
                && !lineage.output_pending
                && !lineage.tainted
                && !self.record.pending.is_empty()
                && self.record.pending.values().all(|pending| pending.exposed)
        });
        let rebuild = match &self.record.lineage {
            Some(lineage) => {
                let clean = !lineage.output_pending && !lineage.tainted;
                if self.record.in_flight {
                    let unchanged = clean
                        && lineage.configuration == configuration
                        && result_extension(
                            &lineage.history,
                            &proof,
                            &replies,
                            self.rpc.is_some(),
                        )?;
                    if unchanged && (self.rpc.is_some() || !self.record.checkpoint.is_empty()) {
                        false
                    } else if quiescent && complete {
                        // All known exposed actions have authoritative results,
                        // none were sent on this park, and no output is uncertain.
                        // A fresh conversation safely delivers steering, rewrites,
                        // system/onPayload changes, and newly activated tools.
                        true
                    } else if !self.record.had_actions
                        && self.record.pending.is_empty()
                        && self.rpc.is_none()
                    {
                        true // explicit action-free recovery, never an automatic output retry
                    } else {
                        ensure!(
                            unchanged,
                            "Host history/configuration diverged during an uncertain action turn"
                        );
                        false // open() retains the missing-checkpoint recovery fence
                    }
                } else {
                    ensure!(
                        self.record.pending.is_empty(),
                        "Completed turn has unresolved host calls"
                    );
                    !(clean
                        && lineage.configuration == configuration
                        && proof.history.starts_with(&lineage.history)
                        && proof.history[lineage.history.len()..]
                            .iter()
                            .all(|item| item.kind == USER))
                }
            }
            None => {
                ensure!(
                    self.record.pending.is_empty() && (!self.record.in_flight || !self.record.had_actions),
                    "Interrupted action journal has no transcript provenance; refusing blind checkpoint restore"
                );
                // Old journals are readable, but their checkpoints are not a
                // lineage attestation. Migrate only at an action-free boundary.
                if !job.results.is_empty() && self.rpc.is_none() {
                    ensure!(
                        job.input
                            .prompt
                            .last()
                            .and_then(|m| m.get("role"))
                            .and_then(Value::as_str)
                            == Some("user"),
                        "Host-action continuation requires established transcript provenance"
                    );
                }
                self.rpc.is_none() || !self.record.checkpoint.is_empty()
            }
        };
        // Drop staged context before its build charge on every early return.
        let mut next_build = None;
        let mut next_context = None;
        let new_conversation = uuid::Uuid::new_v4().to_string();
        if rebuild {
            ensure!(
                complete,
                "Fresh continuation needs complete, reconciled assistant calls and results"
            );
            ensure!(
                self.record.pending.len() == replies.len(),
                "Unexposed host actions cannot be discarded by a history rebuild"
            );
            // Validate/build transactionally before consuming results or stopping
            // a valid park. No stale summaries, opaque fields or blobs survive.
            let build = protocol::request_build_lease(&job.input, None)?;
            let mut context = WireContext::default();
            protocol::build_request(&job.input, &new_conversation, None, &mut context)?;
            next_context = Some(context);
            next_build = Some(build);
        }
        // The rollback snapshot is a real deep copy, not another owner of the
        // transferred restore lease. Admit it before cloning.
        let _snapshot = ByteLease::reserve(
            self.record.resident_bytes()
                + job
                    .results
                    .values()
                    .map(resource::value_bytes)
                    .sum::<usize>()
                    * 2,
        )?;
        let mut candidate = self.record.clone();
        if rebuild {
            candidate.conversation = new_conversation;
            candidate.checkpoint.clear();
            candidate.in_flight = false;
            candidate.had_actions = false;
        }
        for (tool, output) in &replies {
            candidate.pending.remove(&tool.tool_call_id);
            candidate.completed.insert(
                tool.tool_call_id.clone(),
                Completed {
                    tool: tool.clone(),
                    output: output.clone(),
                },
            );
        }
        // Preserve exact historical identities, but never synthesize an exec
        // envelope to send proactively. Cursor must re-issue its own exec ID.
        for (id, tool) in &proof.calls {
            if let Some(output) = job.results.get(id) {
                if !candidate.pending.contains_key(id) && !candidate.completed.contains_key(id) {
                    candidate.completed.insert(
                        id.clone(),
                        Completed {
                            tool: tool.clone(),
                            output: output.clone(),
                        },
                    );
                }
            }
        }
        candidate.lineage = Some(Lineage {
            history: proof.history,
            configuration,
            output_pending: false,
            awaiting_results: false,
            tainted: false,
        });
        candidate.validate()?;
        if rebuild {
            // Seal the receive queue only after validating the entire candidate.
            // Frames accepted during validation must not vanish with the old
            // stream. Later network frames cannot enter the closed receiver.
            self.drain_parked(true).await?;
            ensure!(
                self.record.pending.len() == replies.len()
                    && self.record.pending.values().all(|pending| pending.exposed)
                    && (!self.record.had_actions && self.record.pending.is_empty()
                        || self
                            .record
                            .lineage
                            .as_ref()
                            .is_none_or(|lineage| !lineage.tainted && !lineage.output_pending)),
                "Old RPC made unaccounted progress before the safe rebuild boundary"
            );
        }
        let context = next_context.as_ref().unwrap_or(&self.context);
        let prospective = candidate.resident_bytes()
            + context.blobs.values().map(Vec::capacity).sum::<usize>()
            + context
                .tools
                .iter()
                .map(resource::value_bytes)
                .sum::<usize>()
            + context.workspace.capacity();
        let previous = self.resident_bytes();
        // Keep the old charge through rollback; staging/snapshot leases cover
        // the simultaneous copies. Admit growth BEFORE installation or persist.
        self.resident.resize(previous.max(prospective))?;
        let old_record = std::mem::replace(&mut self.record, candidate);
        let old_context = next_context.map(|context| std::mem::replace(&mut self.context, context));
        if let Err(error) = self.persist() {
            self.record = old_record;
            if let Some(context) = old_context {
                self.context = context;
            }
            self.resident.resize(previous)?; // shrink only, cannot fail
            return Err(error);
        }
        drop(old_record);
        drop(old_context);
        self.resident.resize(prospective)?; // shrink only, cannot fail
        drop(next_build);
        if rebuild {
            self.stop_rpc();
            self.output_proof = None;
            self.recovery_fence = false;
            self.rejects = 0;
        }
        Ok(replies)
    }
    async fn open(&mut self, job: &Job) -> Result<()> {
        if self.record.lineage.is_none() {
            ensure!(
                !self.record.in_flight && self.record.checkpoint.is_empty(),
                "Checkpoint has no transcript provenance"
            );
            self.record.lineage = Some(Lineage {
                history: transcript_proof(&job.input)?.history,
                configuration: configuration(&job.input)?,
                output_pending: false,
                awaiting_results: false,
                tainted: false,
            });
        }
        if self.record.in_flight {
            ensure!(
                self.record
                    .lineage
                    .as_ref()
                    .is_some_and(|lineage| !lineage.output_pending && !lineage.tainted),
                "Interrupted output/protocol state cannot be safely replayed"
            );
            ensure!(!self.record.checkpoint.is_empty(), "Interrupted turn has no checkpoint; refusing blind replay. Remove the scope only after reconciling host actions");
            self.recovery_fence = self.record.had_actions;
        } else {
            self.record.had_actions = false;
            self.recovery_fence = false;
            self.rejects = 0;
        }
        let checkpoint = if self.record.checkpoint.is_empty() {
            None
        } else {
            Some(self.record.checkpoint.as_slice())
        };
        // Existing retained payloads remain charged; staging scales with this
        // request, not the maximum legal store size.
        let _build = protocol::request_build_lease(&job.input, checkpoint)?;
        let record_bytes = self.record.resident_bytes();
        let previous = self.resident_bytes();
        let resident = &mut self.resident;
        let initial = protocol::build_request_admitted(
            &job.input,
            &self.record.conversation,
            checkpoint,
            &mut self.context,
            |context_bytes| {
                resident.resize(previous.max(record_bytes + context_bytes))?;
                Ok(())
            },
        )
        .map_err(|_| {
            anyhow!(
                "Cannot build Cursor request safely (prompt, tools, checkpoint, or blob bounds)"
            )
        })?;
        self.resident.resize(self.resident_bytes())?; // shrink only after installation
        self.record.in_flight = true;
        self.persist()?;
        let timeout = tuning(
            job.input.connect_timeout_ms,
            "OPENCODE_CURSOR_H2_CONNECT_TIMEOUT_MS",
            30_000,
        )
        .clamp(100, 180_000);
        let rpc = tokio::select! {
            biased;
            _ = self.stop.cancelled() => bail!("Cursor engine stopped"),
            _ = job.output.control.cancel.cancelled() => bail!("Cursor request aborted"),
            result = transport::open(&self.client, &self.route, RUN_PATH, &job.token, initial, timeout) => result?,
        };
        watch_cancel(
            job.output.control.clone(),
            rpc.cancel.clone(),
            self.stop.clone(),
        );
        heartbeat(&rpc, self.stop.clone());
        self.rpc = Some(rpc);
        Ok(())
    }
    async fn run_job(&mut self, job: &mut Job) -> std::result::Result<(), &'static str> {
        let replies = self.reconcile(job).await.map_err(|_| {
            "Host results do not match pending calls, tool identities/results changed, or history/recovery provenance diverged; no result was consumed"
        })?;
        job.output.accepted = true;
        if let Some(rpc) = &self.rpc {
            watch_cancel(
                job.output.control.clone(),
                rpc.cancel.clone(),
                self.stop.clone(),
            );
        }
        if self.rpc.is_none() {
            // This is an explicit new host request, not an automatic retry.
            // Also repairs action-free journals left in flight by an engine
            // restart before cancellation/terminal cleanup could be committed.
            self.abandon_action_free_turn()
                .map_err(|_| "Cannot durably abandon interrupted Cursor turn")?;
        }
        job.output
            .emit(
                json!({"type":"response-metadata","id":uuid::Uuid::new_v4().to_string(),"modelId":job.input.model_id}),
            )
            .await?;
        let mut retries = 0;
        let limit = job
            .input
            .max_retries
            .unwrap_or_else(|| {
                tuning(None, "OPENCODE_CURSOR_STREAM_IDLE_MAX_RETRIES", 5).min(10) as u32
            })
            .min(10);
        let idle_ms = tuning(
            job.input.idle_timeout_ms,
            "OPENCODE_CURSOR_STREAM_IDLE_TIMEOUT_MS",
            180_000,
        )
        .clamp(100, 3_600_000);
        let mut send_replies = self.rpc.is_some();
        loop {
            if self.rpc.is_none() {
                if let Err(error) = self.open(job).await {
                    self.stop_rpc();
                    if error.is::<resource::Exhausted>() {
                        return Err("resource_budget_exhausted");
                    }
                    return Err("Cannot safely open or restore Cursor turn; an interrupted turn requires a valid checkpoint. No unknown host action was replayed");
                }
            }
            if send_replies {
                send_replies = false;
                for (tool, result) in &replies {
                    let raw = protocol::tool_result(tool, result)
                        .map_err(|_| "Unsupported host tool output")?;
                    if let Err(error) = self.send(raw, Some(&job.output)).await {
                        self.stop_rpc();
                        if error.is::<resource::Exhausted>() {
                            return Err("resource_budget_exhausted");
                        }
                        break;
                    }
                }
            }
            if self.rpc.is_some() && self.expose_queued(&mut job.output).await? {
                return Ok(());
            }
            let attempt = if self.rpc.is_none() {
                Attempt::Lost(false)
            } else {
                self.attempt(&mut job.output, Duration::from_millis(idle_ms))
                    .await
            };
            match attempt {
                Attempt::Done => return Ok(()),
                Attempt::Fatal(message) => {
                    self.stop_rpc();
                    return Err(message);
                }
                Attempt::Lost(auth) => {
                    self.stop_rpc();
                    if job.output.control.cancel.is_cancelled() || self.stop.is_cancelled() {
                        return Err("Cursor request aborted");
                    }
                    if job.output.exposed {
                        return Err(if self.record.checkpoint.is_empty() {
                            "Cursor turn interrupted after partial output without a checkpoint; refusing blind replay"
                        } else {
                            "Cursor turn interrupted after output; refusing duplicate output or host actions"
                        });
                    }
                    if retries >= limit {
                        return Err("Cursor turn ended without TurnEnded; safe recovery retry budget exhausted");
                    }
                    // No output from this host step has escaped. For an initial
                    // headers failure there is no action or partial output to replay.
                    // Persist the reset too: refresh/backoff can be cancelled.
                    if self.record.checkpoint.is_empty() {
                        self.abandon_action_free_turn()
                            .map_err(|_| "Cannot durably reset Cursor retry state")?;
                    }
                    if self.record.checkpoint.is_empty() && self.record.in_flight {
                        return Err(
                            "Interrupted host-action turn has no checkpoint; refusing blind replay",
                        );
                    }
                    retries += 1;
                    if auth {
                        self.refresh_token(job).await?;
                    }
                    tokio::select! {
                        biased;
                        _ = self.stop.cancelled() => return Err("Cursor engine stopped"),
                        _ = job.output.control.cancel.cancelled() => return Err("Cursor request aborted"),
                        _ = time::sleep(Duration::from_millis((100u64 << retries.min(4)).min(2000))) => {},
                    }
                }
            }
        }
    }
    async fn refresh_token(&self, job: &mut Job) -> std::result::Result<(), &'static str> {
        job.output.control.refreshing.store(true, Ordering::Release);
        let result = async {
            job.output.emit(json!({"type":"native-token-refresh"})).await?;
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => Err("Cursor engine stopped"),
                _ = job.output.control.cancel.cancelled() => Err("Cursor request aborted"),
                _ = time::sleep(REFRESH_TIMEOUT) => Err("Cursor token refresh timed out"),
                token = job.refresh.recv() => match token { Some(token) => { job.token = token; Ok(()) }, None => Err("Cursor token refresh unavailable") },
            }
        }.await;
        job.output
            .control
            .refreshing
            .store(false, Ordering::Release);
        result
    }
    async fn attempt(&mut self, output: &mut Output, idle: Duration) -> Attempt {
        self.deferring = true;
        let attempt = self.receive(output, idle).await;
        self.deferring = false;
        // Every exit commits what memory already applied; acknowledgements end with the RPC.
        self.acks.clear();
        if self.dirty && self.persist().is_err() && !matches!(attempt, Attempt::Fatal(_)) {
            return Attempt::Fatal("Cannot commit Cursor blob/reply state");
        }
        attempt
    }
    async fn receive(&mut self, output: &mut Output, idle: Duration) -> Attempt {
        let mut deadline = Instant::now() + idle;
        let mut deferred_frames = 0usize;
        let mut deferred_since: Option<Instant> = None;
        loop {
            // A ready queue is not proof of progress and must not bypass cancellation
            // or the idle deadline while a deferred write keeps it continuously busy.
            if self.stop.is_cancelled() {
                return Attempt::Fatal("Cursor engine stopped");
            }
            if output.control.cancel.is_cancelled() {
                return Attempt::Fatal("Cursor request aborted");
            }
            if Instant::now() >= deadline {
                return Attempt::Lost(false);
            }
            let mut queued = None;
            if self.dirty || !self.acks.is_empty() {
                let reply_bytes = self
                    .acks
                    .iter()
                    .fold(0usize, |bytes, ack| bytes.saturating_add(ack.capacity()));
                let at_limit = deferred_frames >= MAX_DEFERRED_FRAMES
                    || reply_bytes >= MAX_DEFERRED_REPLY_BYTES
                    || deferred_since.is_some_and(|since| since.elapsed() >= MAX_DEFERRED_AGE);
                // Coalesce only already-arrived frames, within finite frame/byte/age
                // budgets. A refilled transport queue cannot defer a commit forever.
                if !at_limit {
                    tokio::task::yield_now().await;
                    queued = self
                        .rpc
                        .as_mut()
                        .and_then(|rpc| rpc.incoming.try_recv().ok());
                }
                if queued.is_none() {
                    if let Err(message) = self.flush(Some(output)).await {
                        return Attempt::Fatal(message);
                    }
                    deferred_frames = 0;
                    deferred_since = None;
                }
            }
            let frame = match queued {
                Some(_) if self.stop.is_cancelled() => {
                    return Attempt::Fatal("Cursor engine stopped")
                }
                Some(_) if output.control.cancel.is_cancelled() => {
                    return Attempt::Fatal("Cursor request aborted")
                }
                Some(_) if Instant::now() >= deadline => return Attempt::Lost(false),
                Some(frame) => Some(frame),
                None => tokio::select! {
                    biased;
                    _ = self.stop.cancelled() => return Attempt::Fatal("Cursor engine stopped"),
                    _ = output.control.cancel.cancelled() => return Attempt::Fatal("Cursor request aborted"),
                    _ = time::sleep_until(deadline) => return Attempt::Lost(false),
                    frame = async { match self.rpc.as_mut() { Some(rpc) => rpc.incoming.recv().await, None => None } } => frame,
                },
            };
            match frame {
                Some(Ok(Frame::Message(bytes))) => match self.actions(&bytes, Some(output)).await {
                    Ok(Flow::Done) => return Attempt::Done,
                    Ok(Flow::Progress) => deadline = Instant::now() + idle,
                    Ok(Flow::Liveness) => {}
                    Err(message) => return Attempt::Fatal(message),
                },
                Some(Ok(Frame::End(value))) => return Attempt::Lost(auth_end(&value)),
                Some(Err(error)) if error.is::<resource::Exhausted>() => {
                    return Attempt::Fatal("resource_budget_exhausted")
                }
                Some(Err(error)) => return Attempt::Lost(auth_error(&error.to_string())),
                None => return Attempt::Lost(false),
            }
            if self.dirty || !self.acks.is_empty() {
                deferred_frames = deferred_frames.saturating_add(1);
                deferred_since.get_or_insert_with(Instant::now);
            } else {
                deferred_frames = 0;
                deferred_since = None;
            }
        }
    }
    async fn send(&self, raw: Vec<u8>, output: Option<&Output>) -> Result<()> {
        self.send_payload(resource::Payload::from_vec(raw)?, output)
            .await
    }
    async fn send_payload(
        &self,
        payload: resource::Payload,
        output: Option<&Output>,
    ) -> Result<()> {
        let rpc = self
            .rpc
            .as_ref()
            .ok_or_else(|| anyhow!("Cursor RPC is unavailable"))?;
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => bail!("Cursor engine stopped"),
            _ = async { match output { Some(o) => o.control.cancel.cancelled().await, None => std::future::pending().await } } => bail!("Cursor request aborted"),
            result = time::timeout(Duration::from_secs(5), rpc.outgoing.send_payload(payload)) => result?,
        }
    }
    fn append_history(&mut self, item: HistoryItem) -> Result<()> {
        let lineage = self
            .record
            .lineage
            .as_mut()
            .ok_or_else(|| anyhow!("Missing output provenance"))?;
        ensure!(
            lineage.history.len() < journal::MAX_HISTORY,
            "History provenance limit exceeded"
        );
        lineage.history.push(item);
        Ok(())
    }
    fn seal_output_proof(&mut self) -> Result<()> {
        if let Some((kind, digest)) = self.output_proof.take() {
            self.append_history(HistoryItem {
                kind,
                digest: digest.finalize(),
            })?;
            if let Some(lineage) = &mut self.record.lineage {
                lineage.output_pending = false;
            }
        }
        Ok(())
    }
    fn track_output(&mut self, kind: u8, text: &str) -> Result<()> {
        if self
            .output_proof
            .as_ref()
            .is_none_or(|(old, _)| *old != kind)
        {
            self.seal_output_proof()?;
            let lineage = self
                .record
                .lineage
                .as_mut()
                .ok_or_else(|| anyhow!("Missing output provenance"))?;
            lineage.output_pending = true;
            lineage.awaiting_results = false;
            // A process dying between a delta and its final hash cannot certify
            // that the later host history contains the entire exposed output.
            self.persist()?;
            self.output_proof = Some((kind, Sha256::new()));
        }
        self.output_proof
            .as_mut()
            .ok_or_else(|| anyhow!("Missing output hash"))?
            .1
            .update(text.as_bytes());
        Ok(())
    }
    async fn expose_queued(
        &mut self,
        output: &mut Output,
    ) -> std::result::Result<bool, &'static str> {
        let tools: Vec<_> = self
            .record
            .pending
            .values()
            .filter(|p| !p.exposed)
            .map(|p| p.tool.clone())
            .collect();
        if tools.is_empty() {
            return Ok(false);
        }
        self.seal_output_proof()
            .map_err(|_| "Cannot seal host output provenance")?;
        for tool in &tools {
            if let Some(p) = self.record.pending.get_mut(&tool.tool_call_id) {
                p.exposed = true;
            }
            let item = call_item(tool).map_err(|_| "Cannot hash host action provenance")?;
            self.append_history(item)
                .map_err(|_| "Host history provenance limit exceeded")?;
        }
        self.record.had_actions = true;
        if let Some(lineage) = &mut self.record.lineage {
            lineage.awaiting_results = true;
        }
        self.persist()
            .map_err(|_| "Cannot persist pending host action; no tool call was exposed")?;
        for tool in tools {
            output.tool(&tool).await?;
        }
        output.finish(true).await?;
        Ok(true)
    }
    async fn actions(
        &mut self,
        raw: &[u8],
        output: Option<&mut Output>,
    ) -> std::result::Result<Flow, &'static str> {
        self.actions_with_disposition(raw, output, RpcDisposition::Live)
            .await
    }
    async fn actions_with_disposition(
        &mut self,
        raw: &[u8],
        mut output: Option<&mut Output>,
        disposition: RpcDisposition,
    ) -> std::result::Result<Flow, &'static str> {
        // Binary copies/prost payloads are bounded before parsing; object/allocator
        // overhead remains explicitly outside the payload/RSS contract.
        let reply_copy = self
            .context
            .blobs
            .values()
            .map(Vec::len)
            .max()
            .unwrap_or(0)
            .max(16 * 1024 * 1024);
        let mut working =
            ByteLease::reserve(raw.len().saturating_mul(2).saturating_add(reply_copy * 2))
                .map_err(|_| "resource_budget_exhausted")?;
        self.resident
            .resize(self.resident_bytes().saturating_add(raw.len()))
            .map_err(|_| "resource_budget_exhausted")?;
        let generation = self.context.blob_generation;
        let actions = match protocol::handle_message(raw, &mut self.context) {
            Ok(actions) => actions,
            Err(error) => {
                let message = error.to_string();
                let code = if message.contains("tool_call_id is empty") {
                    "missing_tool_call_id"
                } else if message.contains("exec_id is empty") {
                    "missing_exec_id"
                } else if message.contains("oneof") || message.contains("ambiguous") {
                    "ambiguous_wire"
                } else {
                    "protocol_validation"
                };
                if let Some(active) = output.as_deref_mut() {
                    active.emit(json!({"type":"native-protocol-diagnostic","details":{"code":code,"shape":protocol::diagnostic_shape(raw)}})).await?;
                }
                return Err("Unsupported, corrupt, or out-of-bounds Cursor message; refusing unsafe continuation");
            }
        };
        // A stream waiting on host delivery must not pin this frame's decode/reply headroom.
        if let Some(bytes) =
            output_headroom(&actions, self.output_proof.as_ref().map(|(kind, _)| *kind))
        {
            working.shrink_to(bytes);
        }
        // Only a blob write changes durable state; reads and denials must not pay a commit.
        let stored = self.context.blob_generation != generation;
        let deferring = self.deferring && disposition == RpcDisposition::Live && output.is_some();
        let mut progress = false;
        for action in actions {
            if !matches!(action, ServerAction::Liveness) {
                progress = true;
            }
            match action {
                ServerAction::Liveness => {}
                ServerAction::Tokens(_) => {} // not verified billable usage
                ServerAction::Text(text) => {
                    let o = output.as_deref_mut().ok_or(
                        "Unexpected text while parked on host actions; refusing silent output loss",
                    )?;
                    if !text.is_empty() {
                        self.track_output(TEXT, &text)
                            .map_err(|_| "Cannot persist text output provenance")?;
                        o.delta("text", text).await?;
                    }
                }
                ServerAction::Reasoning(text) => {
                    let o = output
                        .as_deref_mut()
                        .ok_or("Unexpected reasoning while parked on host actions; refusing silent output loss")?;
                    if !text.is_empty() {
                        self.track_output(REASONING, &text)
                            .map_err(|_| "Cannot persist reasoning output provenance")?;
                        o.delta("reasoning", text).await?;
                    }
                }
                ServerAction::Checkpoint(bytes) => {
                    self.record.checkpoint = bytes;
                    if deferring {
                        self.dirty = true;
                    } else {
                        self.persist()
                            .map_err(|_| "Cannot persist checkpoint; recovery stopped")?;
                    }
                }
                ServerAction::Reply(bytes) => {
                    if disposition == RpcDisposition::Frozen {
                        // Only validated KV bookkeeping may outlive its cancelled
                        // RPC. Exec replies/denials are not proof of safe progress.
                        ensure_frozen_kv(raw)?;
                        if stored {
                            self.persist()
                                .map_err(|_| "Cannot commit frozen Cursor blob state")?;
                        }
                        continue;
                    }
                    // KV writes mutate the blob store. Acknowledging only after
                    // commit prevents checkpoints with missing blobs after restart.
                    if deferring && (stored || self.dirty || !self.acks.is_empty()) {
                        // Later replies queue too, so none overtakes an uncommitted ack.
                        self.dirty |= stored;
                        self.acks.push(
                            resource::Payload::from_vec(bytes)
                                .map_err(|_| "resource_budget_exhausted")?,
                        );
                        continue;
                    }
                    if stored {
                        self.persist()
                            .map_err(|_| "Cannot commit Cursor blob/reply state")?;
                    }
                    self.send(bytes, output.as_deref()).await.map_err(|error| {
                        if error.is::<resource::Exhausted>() {
                            "resource_budget_exhausted"
                        } else {
                            "Cursor reply upload failed"
                        }
                    })?;
                }
                ServerAction::RejectedLocal => {
                    self.rejects += 1;
                    if self.rejects >= 8 {
                        return Err("Cursor repeatedly requested forbidden native operations (limit 8); no local tool was executed");
                    }
                }
                ServerAction::Tool(tool) => {
                    if disposition == RpcDisposition::Frozen {
                        return Err("Unexpected tool while draining a frozen RPC");
                    }
                    if deferring {
                        self.flush(output.as_deref()).await?;
                    }
                    if let Some(done) = self.record.completed.get(&tool.tool_call_id) {
                        if !same_action(&done.tool, &tool) {
                            return Err(
                                "Cursor reused a completed tool ID with different arguments",
                            );
                        }
                        let reply = protocol::tool_result(&tool, &done.output)
                            .map_err(|_| "Recorded host result cannot be encoded")?;
                        self.send(reply, output.as_deref()).await.map_err(|error| {
                            if error.is::<resource::Exhausted>() {
                                "resource_budget_exhausted"
                            } else {
                                "Recorded host result upload failed"
                            }
                        })?;
                    } else if let Some(pending) = self.record.pending.get(&tool.tool_call_id) {
                        if !same_action(&pending.tool, &tool) {
                            return Err("Cursor reused a pending tool ID with different arguments");
                        }
                        // Exact ID may be re-issued with a different exec envelope.
                        if let Some(p) = self.record.pending.get_mut(&tool.tool_call_id) {
                            p.tool = tool;
                        }
                        self.persist()
                            .map_err(|_| "Cannot persist pending tool identity")?;
                    } else {
                        if self.recovery_fence {
                            return Err("Interrupted host-action recovery requested an unknown tool ID; refusing possible side-effect replay");
                        }
                        self.record.pending.insert(
                            tool.tool_call_id.clone(),
                            Pending {
                                tool,
                                exposed: false,
                            },
                        );
                        self.persist()
                            .map_err(|_| "Cannot persist pending host action")?;
                    }
                    if let Some(o) = output.as_deref_mut() {
                        if self.expose_queued(o).await? {
                            return Ok(Flow::Done);
                        }
                    }
                }
                ServerAction::Finished => {
                    if !self.record.pending.is_empty() || output.is_none() {
                        return Err("TurnEnded arrived with unresolved host actions or without an active host stream");
                    }
                    if deferring {
                        self.flush(output.as_deref()).await?;
                    }
                    self.seal_output_proof()
                        .map_err(|_| "Cannot seal completed output provenance")?;
                    self.record.in_flight = false;
                    self.record.had_actions = false;
                    if let Some(lineage) = &mut self.record.lineage {
                        lineage.awaiting_results = false;
                    }
                    self.persist().map_err(|_| "Cannot commit completed turn")?;
                    self.stop_rpc();
                    if let Some(o) = output.as_deref_mut() {
                        o.finish(false).await?;
                    }
                    if self.stateless {
                        self.record = Record::new(self.record.scope.clone(), self.record.binding);
                        self.context = WireContext::default();
                        self.output_proof = None;
                    }
                    self.resident
                        .resize(self.resident_bytes())
                        .map_err(|_| "resource_budget_exhausted")?;
                    return Ok(Flow::Done);
                }
            }
        }
        self.resident
            .resize(self.resident_bytes())
            .map_err(|_| "resource_budget_exhausted")?;
        Ok(if progress {
            Flow::Progress
        } else {
            Flow::Liveness
        })
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop_rpc();
        // Covers shutdown/actor expiry as well as cancellation during a job.
        // A failed commit stays fail-closed; the next explicit request may retry
        // action-free cleanup, but action-bearing recovery state is untouched.
        let _ = self.abandon_action_free_turn();
    }
}
enum Attempt {
    Done,
    Lost(bool),
    Fatal(&'static str),
}
enum Flow {
    Done,
    Progress,
    Liveness,
}

struct QueuedEvent {
    value: Value,
    bytes: usize,
    _lease: ByteLease,
}
impl QueuedEvent {
    fn new(value: Value) -> Result<Self> {
        struct Count(usize);
        impl std::io::Write for Count {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                if b.len() > (64 * 1024 * 1024usize).saturating_sub(self.0) {
                    return Err(std::io::Error::other("event_limit"));
                }
                self.0 += b.len();
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut count = Count(0);
        serde_json::to_writer(&mut count, &value)?;
        Ok(Self {
            value,
            bytes: count.0,
            _lease: ByteLease::reserve(count.0)?,
        })
    }
}
struct Output {
    tx: mpsc::Sender<QueuedEvent>,
    control: Arc<Control>,
    stop: CancellationToken,
    block: Option<(&'static str, String)>,
    sequence: u64,
    exposed: bool,
    accepted: bool,
}
impl Output {
    async fn emit(&self, value: Value) -> std::result::Result<(), &'static str> {
        let value = QueuedEvent::new(value).map_err(|_| "resource_budget_exhausted")?;
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => Err("Cursor engine stopped"),
            _ = self.control.cancel.cancelled() => Err("Cursor request aborted"),
            result = time::timeout(Duration::from_secs(30), self.tx.send(value)) => match result { Ok(Ok(())) => Ok(()), _ => Err("Cursor host stream stopped consuming events") },
        }
    }
    async fn close(&mut self) -> std::result::Result<(), &'static str> {
        if let Some((kind, id)) = self.block.take() {
            self.emit(json!({"type":format!("{kind}-end"),"id":id}))
                .await?;
        }
        Ok(())
    }
    async fn delta(
        &mut self,
        kind: &'static str,
        text: String,
    ) -> std::result::Result<(), &'static str> {
        if self.block.as_ref().is_none_or(|(k, _)| *k != kind) {
            self.close().await?;
            self.sequence += 1;
            // Tool IDs remain upstream identities. Content blocks use a fresh,
            // explicitly typed namespace rather than numeric tool-like IDs.
            let id = format!(
                "cursor-native:{kind}:{}:{}",
                uuid::Uuid::new_v4(),
                self.sequence
            );
            self.emit(json!({"type":format!("{kind}-start"),"id":id}))
                .await?;
            self.block = Some((kind, id));
        }
        let id = self
            .block
            .as_ref()
            .map(|(_, id)| id.as_str())
            .ok_or("Output block missing")?;
        self.exposed = true;
        self.emit(json!({"type":format!("{kind}-delta"),"id":id,"delta":text}))
            .await
    }
    async fn tool(&mut self, tool: &PendingTool) -> std::result::Result<(), &'static str> {
        self.close().await?;
        let input =
            serde_json::to_string(&tool.input).map_err(|_| "Cannot encode host tool arguments")?;
        self.exposed = true;
        self.emit(json!({"type":"tool-input-start","id":tool.tool_call_id,"toolName":tool.name}))
            .await?;
        self.emit(json!({"type":"tool-input-delta","id":tool.tool_call_id,"delta":input}))
            .await?;
        self.emit(json!({"type":"tool-input-end","id":tool.tool_call_id}))
            .await?;
        self.emit(json!({"type":"tool-call","toolCallId":tool.tool_call_id,"toolName":tool.name,"input":input,"providerExecuted":false})).await
    }
    async fn finish(&mut self, tools: bool) -> std::result::Result<(), &'static str> {
        self.close().await?;
        self.control.complete();
        self.emit(json!({"type":"finish","finishReason":{"unified":if tools {"tool-calls"} else {"stop"},"raw":if tools {"toolUse"} else {"stop"}},"usage":{"inputTokens":{},"outputTokens":{}},"providerMetadata":{"cursorNative":{"runtime":"rust","nativeVersion":env!("CARGO_PKG_VERSION"),"cacheUsage":"unreported","billingUsage":"not-verified"}}})).await
    }
    async fn error(&mut self, message: &'static str) {
        let _ = self.close().await;
        self.control.complete();
        // Cancellation must still produce a terminal error even though emit()
        // deliberately stops ordinary output after cancellation.
        let _ = time::timeout(
            Duration::from_millis(100),
            // A bounded control error is allowed even when the payload budget is full.
            self.tx.send(QueuedEvent {
                value: json!({"type":"error","error":message}),
                bytes: 256,
                _lease: ByteLease::default(),
            }),
        )
        .await;
    }
}

fn watch_cancel(control: Arc<Control>, rpc: CancellationToken, stop: CancellationToken) {
    // Independent of output backpressure and synchronous, bounded journal I/O.
    // Completion ends the watcher without cancelling an RPC parked for tools.
    tokio::spawn(async move {
        tokio::select! {
            biased;
            _ = control.cancel.cancelled() => rpc.cancel(),
            _ = stop.cancelled() => rpc.cancel(),
            _ = control.done.cancelled() => {},
            _ = rpc.cancelled() => {},
        }
    });
}
fn heartbeat(rpc: &Connection, stop: CancellationToken) {
    let tx = rpc.outgoing.clone();
    let cancel = rpc.cancel.clone();
    tokio::spawn(async move {
        let mut interval = time::interval_at(
            Instant::now() + Duration::from_secs(5),
            Duration::from_secs(5),
        );
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
        let raw = pb::AgentClientMessage {
            message: Some(pb::agent_client_message::Message::ClientHeartbeat(
                pb::ClientHeartbeat {},
            )),
        }
        .encode_to_vec();
        loop {
            tokio::select! { biased; _ = stop.cancelled() => break, _ = cancel.cancelled() => break, _ = interval.tick() => {} }
            tokio::select! {
                biased;
                _ = stop.cancelled() => break,
                _ = cancel.cancelled() => break,
                result = time::timeout(Duration::from_secs(5), tx.send(raw.clone())) => if !matches!(result, Ok(Ok(()))) { cancel.cancel(); break; },
            }
        }
    });
}
fn same_action(a: &PendingTool, b: &PendingTool) -> bool {
    a.tool_call_id == b.tool_call_id && a.name == b.name && a.input == b.input
}
struct TranscriptProof {
    history: Vec<HistoryItem>,
    calls: HashMap<String, PendingTool>,
}
/// Root capacity is an operator condition: name it instead of a generic commit failure.
/// Policy is unchanged; nothing here prunes, tombstones or resets records automatically.
fn capacity_message(code: &str) -> &'static str {
    match code {
        "cache_quota_exceeded" => "cache_quota_exceeded: the Cursor recovery cache root holds its 1 GiB of committed records; the turn stopped before committing further state. Inspect the root with explicit cache maintenance (expired payloads can be compacted) or reset known scopes",
        "cache_entry_quota_exceeded" => "cache_entry_quota_exceeded: the Cursor recovery cache root holds its 4096 records, including tombstones; the turn stopped before committing further state. Reset known scopes or use a new cache root",
        "cache_scan_limit" => "cache_scan_limit: the Cursor recovery cache root has more than 16384 directory entries; the turn stopped before committing further state. Use a new cache root",
        _ => "cache_root_busy: another writer held the Cursor recovery cache root for over one second; the turn stopped before committing further state. Retry after it finishes",
    }
}
/// Admission still needed once a frame is decoded, when it only continues the current
/// output kind: event JSON escapes at most 6x. Persists (including an output-kind switch),
/// replies, re-encoded results and tool exposure keep the full per-frame reservation.
fn output_headroom(actions: &[ServerAction], current: Option<u8>) -> Option<usize> {
    let mut bytes: usize = 64 * 1024;
    for action in actions {
        match action {
            ServerAction::Text(text) if current == Some(TEXT) => {
                bytes = bytes.saturating_add(text.len().saturating_mul(8))
            }
            ServerAction::Reasoning(text) if current == Some(REASONING) => {
                bytes = bytes.saturating_add(text.len().saturating_mul(8))
            }
            ServerAction::Tokens(_) | ServerAction::Liveness => {}
            _ => return None,
        }
    }
    Some(bytes)
}
fn hash_json<T: serde::Serialize + ?Sized>(value: &T) -> Result<[u8; 32]> {
    struct HashWriter {
        digest: Sha256,
        bytes: usize,
    }
    impl std::io::Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_HISTORY_BYTES.saturating_sub(self.bytes) {
                return Err(std::io::Error::other("History hash byte limit"));
            }
            self.bytes += bytes.len();
            self.digest.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = HashWriter {
        digest: Sha256::new(),
        bytes: 0,
    };
    serde_json::to_writer(&mut writer, value)?;
    Ok(writer.digest.finalize())
}
fn call_item(tool: &PendingTool) -> Result<HistoryItem> {
    Ok(HistoryItem {
        kind: CALL,
        digest: hash_json(&json!([tool.tool_call_id, tool.name, tool.input]))?,
    })
}
fn result_item(id: &str, output: &Value) -> Result<HistoryItem> {
    Ok(HistoryItem {
        kind: RESULT,
        digest: hash_json(&json!([id, output]))?,
    })
}
fn configuration(input: &StartInput) -> Result<[u8; 32]> {
    // Include all mutable request semantics which a parked RPC cannot receive
    // through an exec result. Model routing itself is additionally scope-bound.
    hash_json(&json!([input.tools, input.tool_choice, input.reasoning]))
}
fn transcript_proof(input: &StartInput) -> Result<TranscriptProof> {
    // Bound the aggregate serialized transcript too, not just individual parts.
    // Streaming into a digest avoids a second prompt/image allocation.
    hash_json(&input.prompt)?;
    ensure!(
        input.prompt.len() <= journal::MAX_HISTORY,
        "History message limit exceeded"
    );
    let mut proof = TranscriptProof {
        history: Vec::new(),
        calls: HashMap::new(),
    };
    let text = |part: &Value, key: &str| -> Result<String> {
        let value = part
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Invalid history string"))?;
        ensure!(
            value.len() <= MAX_HISTORY_BYTES,
            "History text exceeds limit"
        );
        Ok(value.to_owned())
    };
    for message in &input.prompt {
        match message.get("role").and_then(Value::as_str) {
            Some("system") | Some("user") => {
                let kind = if message["role"] == "system" {
                    SYSTEM
                } else {
                    USER
                };
                let content = message
                    .get("content")
                    .ok_or_else(|| anyhow!("Missing history content"))?;
                proof.history.push(HistoryItem {
                    kind,
                    digest: hash_json(content)?,
                });
            }
            Some(role @ ("assistant" | "tool")) => {
                for part in message
                    .get("content")
                    .and_then(Value::as_array)
                    .ok_or_else(|| anyhow!("Invalid history content"))?
                {
                    let kind = part.get("type").and_then(Value::as_str);
                    ensure!(
                        role != "tool" || kind == Some("tool-result"),
                        "Unsupported host tool content"
                    );
                    let item = match kind {
                        Some("text") | Some("reasoning") => {
                            let value = text(part, "text")?;
                            if value.is_empty() {
                                continue;
                            }
                            HistoryItem {
                                kind: if kind == Some("text") {
                                    TEXT
                                } else {
                                    REASONING
                                },
                                digest: Sha256::digest(value.as_bytes()),
                            }
                        }
                        Some("tool-call") => {
                            ensure!(
                                part.get("providerExecuted").and_then(Value::as_bool) != Some(true),
                                "Provider-executed action is not a host tool"
                            );
                            let tool = PendingTool {
                                exec_id: "host-history".into(),
                                exec_message_id: 0,
                                tool_call_id: text(part, "toolCallId")?,
                                name: text(part, "toolName")?,
                                input: part
                                    .get("input")
                                    .filter(|value| value.is_object())
                                    .ok_or_else(|| anyhow!("Invalid historical tool input"))?
                                    .clone(),
                            };
                            for id in [&tool.tool_call_id, &tool.name] {
                                ensure!(
                                    !id.is_empty() && id.len() <= 1024 && !id.contains('\0'),
                                    "Invalid historical tool identity"
                                );
                            }
                            let item = call_item(&tool)?;
                            ensure!(
                                proof
                                    .calls
                                    .insert(tool.tool_call_id.clone(), tool)
                                    .is_none(),
                                "Duplicate historical tool-call ID"
                            );
                            item
                        }
                        Some("tool-result") => result_item(
                            &text(part, "toolCallId")?,
                            part.get("output")
                                .ok_or_else(|| anyhow!("Missing historical result"))?,
                        )?,
                        _ => bail!("Unsupported historical assistant content"),
                    };
                    ensure!(
                        proof.history.len() < journal::MAX_HISTORY,
                        "History provenance limit exceeded"
                    );
                    proof.history.push(item);
                }
            }
            _ => bail!("Unsupported history role"),
        }
        ensure!(
            proof.history.len() <= journal::MAX_HISTORY,
            "History provenance limit exceeded"
        );
    }
    Ok(proof)
}
fn result_extension(
    history: &[HistoryItem],
    proof: &TranscriptProof,
    replies: &[(PendingTool, Value)],
    allow_result_only: bool,
) -> Result<bool> {
    // Legacy callers may submit result-only messages on a still-live park. They
    // may not use that incomplete transcript to rebuild/restore a conversation.
    let missing_calls: Vec<_> = replies
        .iter()
        .filter(|(tool, _)| !proof.calls.contains_key(&tool.tool_call_id))
        .map(|(tool, _)| call_item(tool))
        .collect::<Result<_>>()?;
    if !allow_result_only && !missing_calls.is_empty() {
        return Ok(false);
    }
    let base: Vec<_> = history
        .iter()
        .filter(|item| !missing_calls.contains(item))
        .cloned()
        .collect();
    if !proof.history.starts_with(&base) {
        return Ok(false);
    }
    let suffix = &proof.history[base.len()..];
    let expected: Vec<_> = replies
        .iter()
        .map(|(tool, output)| result_item(&tool.tool_call_id, output))
        .collect::<Result<_>>()?;
    let mut seen = HashSet::new();
    Ok(suffix.len() == expected.len()
        && suffix
            .iter()
            .all(|item| item.kind == RESULT && expected.contains(item) && seen.insert(item.digest)))
}
fn loopback_origin(route: &str) -> bool {
    url::Url::parse(route)
        .ok()
        .and_then(|url| {
            url.host().map(|host| match host {
                url::Host::Domain(name) => name == "localhost",
                url::Host::Ipv4(ip) => ip.is_loopback(),
                url::Host::Ipv6(ip) => ip.is_loopback(),
            })
        })
        .unwrap_or(false)
}
fn auth_error(error: &str) -> bool {
    let text = error.to_ascii_lowercase();
    text.contains("401") || text.contains("unauthenticated") || text.contains("token expired")
}
fn auth_end(value: &Value) -> bool {
    value.pointer("/error/code").is_some_and(|v| {
        v.as_u64() == Some(16)
            || v.as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("unauthenticated") || s == "16")
    })
}
fn validate_token(token: &str) -> Result<()> {
    ensure!(
        !token.is_empty()
            && token.len() <= 16 * 1024
            && token.bytes().all(|b| b.is_ascii_graphic()),
        "Invalid Cursor access token"
    );
    Ok(())
}
fn validate_input(input: &StartInput) -> Result<()> {
    journal::validate_scope(&input.scope)?;
    let path = Path::new(&input.workspace);
    ensure!(
        path.is_absolute() && input.workspace.len() <= 16 * 1024 && !input.workspace.contains('\0'),
        "Workspace must be an absolute path"
    );
    ensure!(
        !input.model_id.is_empty() && input.model_id.len() <= 1024,
        "Invalid model binding"
    );
    ensure!(
        ["auto", "none"].contains(&input.tool_choice.as_str()),
        "Only auto/none tool choice is supported"
    );
    validate_model_parameters(&input.model_parameters)?;
    Ok(())
}
fn binding(input: &StartInput, route: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    for s in [&input.scope, &input.model_id, &input.workspace, route] {
        h.update((s.len() as u64).to_le_bytes());
        h.update(s.as_bytes());
    }
    h.update([u8::from(input.stateless)]);
    // Default callers retain the old binding so v2 action ledgers remain
    // readable. Non-default routes add an unambiguous, order-independent key.
    if input.max_mode || !input.model_parameters.is_empty() {
        h.update(b"\0cursor-model-parameters-v1\0");
        h.update([u8::from(input.max_mode)]);
        let mut parameters: Vec<_> = input.model_parameters.iter().collect();
        parameters.sort_by(|a, b| a.id.cmp(&b.id).then(a.value.cmp(&b.value)));
        h.update((parameters.len() as u64).to_le_bytes());
        for parameter in parameters {
            for value in [&parameter.id, &parameter.value] {
                h.update((value.len() as u64).to_le_bytes());
                h.update(value.as_bytes());
            }
        }
    }
    h.finalize()
}
fn tuning(value: Option<u64>, env: &str, default: u64) -> u64 {
    value
        .or_else(|| std::env::var(env).ok().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(default)
}
fn cache_root(value: Option<&str>) -> Result<PathBuf> {
    let root = match value {
        Some(path) => PathBuf::from(path),
        None => {
            let base = if let Some(path) = std::env::var_os("OPENCODE_CURSOR_CACHE_DIR") {
                PathBuf::from(path)
            } else if let Some(path) = std::env::var_os("XDG_CACHE_HOME") {
                PathBuf::from(path).join("opencode-cursor-native")
            } else {
                PathBuf::from(
                    std::env::var_os("HOME")
                        .ok_or_else(|| anyhow!("HOME is required for private recovery storage"))?,
                )
                .join(".cache/opencode-cursor-native")
            };
            base.join("rust-sessions-v1")
        }
    };
    ensure!(root.is_absolute(), "Recovery directory must be absolute");
    Ok(root)
}
fn agent_url(explicit: Option<&str>) -> Result<String> {
    let route = explicit
        .map(str::to_owned)
        .or_else(|| {
            std::env::var("OPENCODE_CURSOR_AGENT_URL")
                .ok()
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            std::env::var("CURSOR_AGENT_URL")
                .ok()
                .filter(|s| !s.is_empty())
        })
        .or_else(cli_route)
        .unwrap_or_else(|| "https://agentn.us.api5.cursor.sh".to_owned());
    let parsed = url::Url::parse(&route).map_err(|_| anyhow!("Invalid Cursor route"))?;
    ensure!(
        route.len() <= 4096
            && route.trim() == route
            && !route.chars().any(char::is_control)
            && !route.contains('\\')
            && !route.contains('@')
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none(),
        "Cursor route must not contain credentials, query parameters, or fragments"
    );
    ensure!(
        parsed.scheme() == "https"
            || parsed.scheme() == "http"
                && parsed.host().is_some_and(|h| match h {
                    url::Host::Domain(d) => d == "localhost",
                    url::Host::Ipv4(ip) => ip.is_loopback(),
                    url::Host::Ipv6(ip) => ip.is_loopback(),
                }),
        "Cursor route requires HTTPS (HTTP is only allowed for loopback fixtures)"
    );
    ensure!(parsed.host().is_some(), "Cursor route has no host");
    // Transport applies its destination allowlist before attaching credentials.
    Ok(parsed.origin().ascii_serialization())
}
fn cli_route() -> Option<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Routing {
        server_config_cache: Option<Cache>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Cache {
        agent_url_config: Option<Route>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Route {
        agentn_url: Option<String>,
        agent_url: Option<String>,
    }
    let root = std::env::var_os("CURSOR_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cursor")))?;
    let path = root.join("cli-config.json");
    let m = std::fs::symlink_metadata(&path).ok()?;
    if !m.is_file() || m.len() > 1024 * 1024 {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 1024 * 1024 {
        return None;
    }
    // Deserialize only routing fields. Never inspect CLI authentication files.
    let route = serde_json::from_slice::<Routing>(&bytes)
        .ok()?
        .server_config_cache?
        .agent_url_config?;
    route.agentn_url.or(route.agent_url)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Result<StartInput> {
        Ok(serde_json::from_value(
            json!({"scope":"a".repeat(64),"modelId":"auto","workspace":"/tmp/test-workspace","prompt":[{"role":"user","content":[{"type":"text","text":"test"}]}],"stateless":true,"agentUrl":"http://127.0.0.1:9","maxRetries":0}),
        )?)
    }
    fn output(
        busy: Arc<AtomicBool>,
        stop: CancellationToken,
    ) -> (Output, RunningStream, mpsc::Receiver<String>) {
        let control = Arc::new(Control {
            cancel: CancellationToken::new(),
            done: CancellationToken::new(),
            finished: AtomicBool::new(false),
            refreshing: AtomicBool::new(false),
            busy,
        });
        let (tx, rx) = mpsc::channel(32);
        let (refresh, updates) = mpsc::channel(1);
        (
            Output {
                tx,
                control: control.clone(),
                stop,
                block: None,
                sequence: 0,
                exposed: false,
                accepted: false,
            },
            RunningStream {
                events: tokio::sync::Mutex::new(rx),
                control,
                refresh,
            },
            updates,
        )
    }
    fn job(
        input: StartInput,
        busy: Arc<AtomicBool>,
        stop: CancellationToken,
    ) -> Result<(Job, RunningStream)> {
        let results = protocol::parse_tool_results(&input)?;
        let (output, stream, refresh) = output(busy, stop);
        let lease = Lease(output.control.clone());
        Ok((
            Job {
                input,
                results,
                token: "fixture-token".into(),
                output,
                refresh,
                _lease: lease,
            },
            stream,
        ))
    }
    #[test]
    fn only_output_continuations_release_frame_headroom() {
        let text = || ServerAction::Text("delta".into());
        assert_eq!(
            output_headroom(&[text(), ServerAction::Liveness, text()], Some(TEXT)),
            Some(64 * 1024 + 80)
        );
        assert_eq!(
            output_headroom(&[ServerAction::Tokens(3)], None),
            Some(64 * 1024)
        );
        // First output or a kind switch persists provenance; keep the full reservation.
        assert_eq!(output_headroom(&[text()], None), None);
        assert_eq!(output_headroom(&[text()], Some(REASONING)), None);
        assert_eq!(
            output_headroom(&[text(), ServerAction::Reply(vec![0; 8])], Some(TEXT)),
            None
        );
        assert_eq!(output_headroom(&[ServerAction::Finished], Some(TEXT)), None);
    }
    #[test]
    fn shutdown_during_registry_admission_cannot_create_a_late_journal() -> Result<()> {
        let engine = Engine::new()?;
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("must-not-be-created");
        let mut request = input()?;
        request.cache_dir = Some(root.to_string_lossy().into_owned());
        let retired = engine
            .inner
            .retired
            .lock()
            .map_err(|_| anyhow!("registry lock"))?;
        let starter = engine.clone();
        let thread = std::thread::spawn(move || -> Result<RunningStream> {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(starter.start(request, "fixture-token".into()))
        });
        // A held slots lock proves start passed its first shutdown check and is
        // waiting for the retired registry, rather than relying on a sleep race.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut admitted = false;
        while std::time::Instant::now() < deadline {
            if engine.inner.slots.try_lock().is_err() {
                admitted = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        engine.inner.stop.cancel();
        drop(retired);
        let result = thread.join().map_err(|_| anyhow!("starter panicked"))?;
        ensure!(admitted, "Start never reached registry admission");
        match result {
            Err(error) => ensure!(error.to_string().contains("shut down"), "Wrong failure"),
            Ok(stream) => {
                stream.cancel();
                bail!("A shutdown engine admitted a late journal");
            }
        }
        ensure!(!root.exists(), "Shutdown start created a cache root");
        ensure!(
            engine
                .inner
                .slots
                .lock()
                .map_err(|_| anyhow!("slots"))?
                .is_empty(),
            "Shutdown start installed an actor"
        );
        Ok(())
    }
    #[tokio::test]
    async fn resource_failure_is_fatal_and_unknown_maintenance_never_selects_a_default_root(
    ) -> Result<()> {
        let engine = Engine::new()?;
        assert_eq!(
            engine
                .maintain_cache(&"f".repeat(64), false)
                .await
                .expect_err("unknown scope")
                .to_string(),
            "cache_unknown_scope"
        );
        let stats: Value = serde_json::from_str(&engine.resource_stats())?;
        assert_eq!(stats["limitBytes"], resource::DEFAULT_LIMIT);
        assert_eq!(stats["rssBounded"], false);
        let mut session = session()?;
        let (rpc, incoming, _outgoing) = fake_rpc();
        session.rpc = Some(rpc);
        incoming.send(Err(resource::Exhausted.into())).await?;
        let (mut job, _stream) = job(
            input()?,
            Arc::new(AtomicBool::new(true)),
            CancellationToken::new(),
        )?;
        assert!(matches!(
            session
                .attempt(&mut job.output, Duration::from_secs(1))
                .await,
            Attempt::Fatal("resource_budget_exhausted")
        ));
        Ok(())
    }
    #[tokio::test]
    async fn builder_resident_denial_preserves_open_and_reconcile_contexts() -> Result<()> {
        let mut s = session()?;
        s.context.blobs.insert("01".into(), b"uncertainty".to_vec());
        let previous = s.resident_bytes();
        s.resident = ByteLease::isolated_for_test(previous);
        s.resident.resize(previous)?;
        let before = s.context.blobs.clone();
        let (j, _stream) = job(input()?, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
        assert!(s.open(&j).await.is_err());
        assert_eq!(s.context.blobs, before);
        assert!(s.context.tools.is_empty() && s.context.workspace.is_empty());
        assert!(!s.record.in_flight);
        assert_eq!(s.resident.bytes(), previous);
        for rebuild in [false, true] {
            let (mut s, mut i) = pending_session()?;
            s.context.blobs.insert("01".into(), b"uncertainty".to_vec());
            let previous = s.resident_bytes();
            s.resident = ByteLease::isolated_for_test(previous);
            s.resident.resize(previous)?;
            let before = s.record.clone();
            let blobs = s.context.blobs.clone();
            let tools = s.context.tools.clone();
            append_result(
                &mut i,
                "call",
                "read",
                json!({}),
                json!({"type":"text","value":"x".repeat(8192)}),
            );
            if rebuild {
                i.prompt
                    .push(json!({"role":"user","content":"new steering"}));
            }
            let (j, _stream) = job(i, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
            assert!(s
                .reconcile(&j)
                .await
                .expect_err("admission")
                .is::<resource::Exhausted>());
            assert_eq!(s.record.conversation, before.conversation);
            assert_eq!(s.record.checkpoint, before.checkpoint);
            assert!(s.record.pending["call"].exposed && s.record.completed.is_empty());
            assert_eq!(s.context.blobs, blobs);
            assert_eq!(s.context.tools, tools);
            assert_eq!(s.resident.bytes(), previous);
            assert!(!s.blocked, "denied before any record/context installation");
        }
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn root_busy_after_staged_tool_exposes_nothing_and_keeps_explicit_fence() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let (mut s, i) = pending_session()?;
        s.record.pending.get_mut("call").expect("pending").exposed = false;
        let lineage = s.record.lineage.as_mut().expect("lineage");
        lineage.history.pop();
        lineage.awaiting_results = false;
        s.journal = Some(Journal::open(
            &tmp.path().canonicalize()?.join("private"),
            &s.record.scope,
        )?);
        s.persist()?;
        let quota = s.journal.as_ref().expect("journal").hold_quota_for_test()?;
        let (mut output, stream, _) =
            output(Arc::new(AtomicBool::new(true)), CancellationToken::new());
        assert!(s.expose_queued(&mut output).await.is_err());
        assert!(s.blocked, "failed persist must fence surviving mutations");
        assert_eq!(s.capacity, Some("cache_root_busy"));
        assert!(capacity_message("cache_root_busy").starts_with("cache_root_busy:"));
        assert!(s.record.pending["call"].exposed);
        assert!(s.record.lineage.as_ref().expect("lineage").awaiting_results);
        let saved = s
            .journal
            .as_ref()
            .expect("journal")
            .load(s.record.binding)?
            .expect("saved");
        assert!(!saved.pending["call"].exposed);
        assert!(!output.exposed);
        drop(output);
        assert!(collect(&stream).await?.is_empty(), "no host tool or finish");
        drop(quota);
        let (j, _stream) = job(i, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
        assert!(s
            .reconcile(&j)
            .await
            .expect_err("fenced")
            .to_string()
            .contains("blocked"));
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn concurrent_tiny_actor_builds_and_cross_scope_commits() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("private");
        let barrier = Arc::new(std::sync::Barrier::new(16));
        let mut writers = Vec::new();
        for n in 0..16 {
            let root = root.clone();
            let barrier = barrier.clone();
            writers.push(std::thread::spawn(move || -> Result<()> {
                let mut i = input()?;
                i.scope = format!("{n:064x}");
                let record = Record::new(i.scope.clone(), [7; 32]);
                let journal = Journal::open(&root, &i.scope)?;
                let mut s = Session::new(
                    record,
                    Some(journal.clone()),
                    i.agent_url.clone().expect("fixture route"),
                    transport::client()?,
                    CancellationToken::new(),
                    false,
                )?;
                let _build = protocol::request_build_lease(&i, None)?;
                barrier.wait(); // All staging leases coexist, not serialized builders.
                protocol::build_request(&i, &s.record.conversation, None, &mut s.context)?;
                s.resident.resize(s.resident_bytes())?;
                for _ in 0..4 {
                    s.persist()?;
                }
                assert!(!s.blocked);
                assert!(journal.load([7; 32])?.is_some());
                Ok(())
            }));
        }
        let results = writers
            .into_iter()
            .map(|writer| {
                writer
                    .join()
                    .map_err(|_| anyhow!("writer panic"))
                    .and_then(|r| r)
            })
            .collect::<Vec<_>>();
        for result in results {
            result?;
        }
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn large_restore_transfers_lease_and_builds_without_store_sized_reservation() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let i = input()?;
        let mut record = Record::new(i.scope.clone(), [7; 32]);
        let mut context = WireContext::default();
        protocol::build_request(&i, &record.conversation, None, &mut context)?;
        let mut remaining =
            journal::MAX_STORE - context.blobs.values().map(Vec::len).sum::<usize>();
        let mut n = 0;
        while remaining > 0 {
            let bytes = remaining.min(journal::MAX_BLOB);
            context.blobs.insert(format!("{n:0128x}"), vec![0; bytes]);
            remaining -= bytes;
            n += 1;
        }
        record.blobs = context.blobs;
        let journal = Journal::open(&tmp.path().canonicalize()?.join("private"), &i.scope)?;
        journal.save(&record)?;
        drop(record);
        let loaded = journal.load([7; 32])?.expect("saved record");
        let mut s = Session::new(
            loaded,
            Some(journal),
            i.agent_url.clone().expect("fixture route"),
            transport::client()?,
            CancellationToken::new(),
            false,
        )?;
        assert_eq!(s.resident.bytes(), journal::MAX_STORE);
        assert_eq!(s.record.take_resident().bytes(), 0);
        let _build = protocol::request_build_lease(&i, None)?;
        protocol::build_request(&i, &s.record.conversation, None, &mut s.context)?;
        s.resident.resize(s.resident_bytes())?;
        assert!(s.resident.bytes() < journal::MAX_STORE + 1024 * 1024);
        Ok(())
    }

    fn fake_rpc() -> (
        Connection,
        mpsc::Sender<Result<Frame>>,
        mpsc::Receiver<resource::Payload>,
    ) {
        let (incoming, rx) = mpsc::channel(32);
        let (tx, outgoing) = mpsc::channel(32);
        (
            Connection {
                incoming: rx,
                outgoing: transport::PayloadSender(tx),
                cancel: CancellationToken::new(),
            },
            incoming,
            outgoing,
        )
    }
    fn session() -> Result<Session> {
        let i = input()?;
        Session::new(
            Record::new(i.scope.clone(), binding(&i, "http://127.0.0.1:9")),
            None,
            "http://127.0.0.1:9".into(),
            transport::client()?,
            CancellationToken::new(),
            false,
        )
    }
    fn server(message: pb::agent_server_message::Message) -> Frame {
        Frame::message(
            pb::AgentServerMessage {
                message: Some(message),
                ..Default::default()
            }
            .encode_to_vec(),
        )
    }
    fn update(message: pb::interaction_update::Message) -> Frame {
        server(pb::agent_server_message::Message::InteractionUpdate(
            pb::InteractionUpdate {
                message: Some(message),
                ..Default::default()
            },
        ))
    }
    fn tool_message(id: &str) -> Vec<u8> {
        pb::AgentServerMessage {
            message: Some(pb::agent_server_message::Message::ExecServerMessage(
                pb::ExecServerMessage {
                    id: 7,
                    exec_id: "exec".into(),
                    message: Some(pb::exec_server_message::Message::McpArgs(pb::McpArgs {
                        name: "pi-mcp_pi_read".into(),
                        tool_name: "mcp_pi_read".into(),
                        provider_identifier: "pi".into(),
                        tool_call_id: id.into(),
                        args: HashMap::new(),
                    })),
                    ..Default::default()
                },
            )),
            ..Default::default()
        }
        .encode_to_vec()
    }
    fn append_result(input: &mut StartInput, id: &str, name: &str, args: Value, output: Value) {
        input.prompt.push(json!({"role":"assistant","content":[{"type":"tool-call","toolCallId":id,"toolName":name,"input":args}]}));
        input.prompt.push(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":id,"output":output}]}));
    }
    fn tools() -> Vec<Value> {
        vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})]
    }
    fn metadata_checkpoint() -> pb::ConversationStateStructure {
        pb::ConversationStateStructure {
            summary: Some(b"STALE-SUMMARY".to_vec()),
            summary_archive: Some(b"STALE-ARCHIVE".to_vec()),
            extra_state: b"STALE-OPAQUE".to_vec(),
            mode: Some(1),
            ..Default::default()
        }
    }
    fn named_tool_message(id: &str, name: &str) -> Vec<u8> {
        let mut message =
            pb::AgentServerMessage::decode(tool_message(id).as_slice()).expect("fixture");
        if let Some(pb::agent_server_message::Message::ExecServerMessage(exec)) =
            &mut message.message
        {
            if let Some(pb::exec_server_message::Message::McpArgs(args)) = &mut exec.message {
                args.name = format!("pi-mcp_pi_{name}");
                args.tool_name = format!("mcp_pi_{name}");
            }
        }
        message.encode_to_vec()
    }
    fn pending_session() -> Result<(Session, StartInput)> {
        let mut s = session()?;
        let mut i = input()?;
        i.tools = tools();
        s.context.tools = i.tools.clone();
        let mut history = transcript_proof(&i)?.history;
        let tool = PendingTool {
            exec_id: "exec".into(),
            exec_message_id: 7,
            tool_call_id: "call".into(),
            name: "read".into(),
            input: json!({}),
        };
        history.push(call_item(&tool)?);
        s.record.pending.insert(
            "call".into(),
            Pending {
                tool,
                exposed: true,
            },
        );
        s.record.in_flight = true;
        s.record.had_actions = true;
        s.record.checkpoint = metadata_checkpoint().encode_to_vec();
        s.record.lineage = Some(Lineage {
            history,
            configuration: configuration(&i)?,
            output_pending: false,
            awaiting_results: true,
            tainted: false,
        });
        Ok((s, i))
    }
    async fn collect(stream: &RunningStream) -> Result<Vec<Value>> {
        Ok(time::timeout(Duration::from_secs(2), async {
            let mut events = Vec::new();
            while let Some(e) = stream.next().await {
                events.push(e);
            }
            events
        })
        .await?)
    }
    type RpcRequest = (
        http::Request<h2::RecvStream>,
        h2::server::SendResponse<bytes::Bytes>,
    );
    struct RpcFixture {
        url: String,
        requests: mpsc::Receiver<RpcRequest>,
        // Concurrent unary discovery can arrive in either order.
        early: Vec<RpcRequest>,
        stop: CancellationToken,
        driver: tokio::task::JoinHandle<Result<()>>,
    }
    impl RpcFixture {
        async fn new() -> Result<Self> {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let url = format!("http://{}", listener.local_addr()?);
            let (tx, requests) = mpsc::channel(8);
            let stop = CancellationToken::new();
            let stopped = stop.clone();
            let driver = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        biased;
                        _ = stopped.cancelled() => {
                            connections.shutdown().await;
                            return Ok(());
                        }
                        socket = listener.accept() => {
                            let (socket, _) = socket?;
                            let tx = tx.clone();
                            let stopped = stopped.clone();
                            connections.spawn(async move {
                                let mut connection = h2::server::handshake(socket).await?;
                                loop {
                                    tokio::select! {
                                        biased;
                                        _ = stopped.cancelled() => return Ok::<(), anyhow::Error>(()),
                                        request = connection.accept() => match request {
                                            Some(Ok(request)) => tx.send(request).await.map_err(|_| anyhow!("Fixture closed"))?,
                                            _ => return Ok(()),
                                        },
                                    }
                                }
                            });
                        }
                        result = connections.join_next(), if !connections.is_empty() => {
                            result.ok_or_else(|| anyhow!("Missing fixture driver"))???;
                        }
                    }
                }
            });
            Ok(Self {
                url,
                requests,
                early: Vec::new(),
                stop,
                driver,
            })
        }
        async fn request(&mut self) -> Result<RpcRequest> {
            if !self.early.is_empty() {
                return Ok(self.early.remove(0));
            }
            time::timeout(Duration::from_secs(2), self.requests.recv())
                .await?
                .ok_or_else(|| anyhow!("Expected an actual reopened RPC"))
        }
        async fn request_to(&mut self, path: &str) -> Result<RpcRequest> {
            if let Some(index) = self.early.iter().position(|(r, _)| r.uri().path() == path) {
                return Ok(self.early.remove(index));
            }
            loop {
                let next = time::timeout(Duration::from_secs(2), self.requests.recv())
                    .await?
                    .ok_or_else(|| anyhow!("Expected a request to {path}"))?;
                if next.0.uri().path() == path {
                    return Ok(next);
                }
                self.early.push(next);
            }
        }
        async fn close(mut self) -> Result<()> {
            self.stop.cancel();
            time::timeout(Duration::from_secs(2), &mut self.driver).await???;
            Ok(())
        }
    }
    impl Drop for RpcFixture {
        fn drop(&mut self) {
            self.stop.cancel();
        }
    }
    async fn client_message(body: &mut h2::RecvStream) -> Result<pb::AgentClientMessage> {
        time::timeout(Duration::from_secs(2), async {
            let mut bytes = Vec::new();
            loop {
                let chunk = body
                    .data()
                    .await
                    .ok_or_else(|| anyhow!("Missing request DATA"))??;
                body.flow_control().release_capacity(chunk.len())?;
                bytes.extend_from_slice(&chunk);
                if bytes.len() >= 5 {
                    let length = u32::from_be_bytes(bytes[1..5].try_into()?) as usize;
                    ensure!(
                        bytes[0] == 0 && length < 1024 * 1024,
                        "Invalid fixture request envelope"
                    );
                    if bytes.len() >= length + 5 {
                        ensure!(
                            bytes.len() == length + 5,
                            "Unexpected additional request message"
                        );
                        return Ok(pb::AgentClientMessage::decode(&bytes[5..])?);
                    }
                }
            }
        })
        .await?
    }
    async fn unary_body(mut body: h2::RecvStream) -> Result<Vec<u8>> {
        time::timeout(Duration::from_secs(2), async {
            let mut bytes = Vec::new();
            while let Some(chunk) = body.data().await {
                let chunk = chunk?;
                body.flow_control().release_capacity(chunk.len())?;
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
        .await?
    }
    fn unary_response(
        response: &mut h2::server::SendResponse<bytes::Bytes>,
        bytes: Vec<u8>,
    ) -> Result<()> {
        let mut send = response.send_response(
            http::Response::builder()
                .header(http::header::CONTENT_TYPE, "application/proto")
                .body(())?,
            false,
        )?;
        send.send_data(bytes.into(), true)?;
        Ok(())
    }
    fn metadata_image_fixture() -> Vec<u8> {
        // AvailableModelsResponse.models(2), Model.name(1), supports_images(10).
        // The basic catalog alone never attests image support.
        b"\x12\x0b\x0a\x07default\x50\x01".to_vec()
    }
    async fn basic_model_response(fixture: &mut RpcFixture) -> Result<()> {
        let (request, mut response) = fixture
            .request_to(&protocol::model_list_request().0)
            .await?;
        assert_eq!(request.uri().path(), protocol::model_list_request().0);
        assert_eq!(
            request.headers()[http::header::CONTENT_TYPE],
            "application/proto"
        );
        assert_eq!(
            unary_body(request.into_body()).await?,
            protocol::model_list_request().1
        );
        unary_response(
            &mut response,
            pb::GetUsableModelsResponse {
                models: vec![pb::ModelDetails {
                    model_id: "default".into(),
                    display_name: "Auto".into(),
                    ..Default::default()
                }],
            }
            .encode_to_vec(),
        )
    }
    async fn run_request(body: &mut h2::RecvStream) -> Result<pb::AgentRunRequest> {
        match client_message(body).await?.message {
            Some(pb::agent_client_message::Message::RunRequest(run)) => Ok(run),
            _ => bail!("Expected a real RunRequest"),
        }
    }
    fn send_frames(
        send: &mut h2::SendStream<bytes::Bytes>,
        frames: Vec<Frame>,
        end: bool,
    ) -> Result<()> {
        let mut bytes = Vec::new();
        for frame in frames {
            let (flag, payload) = match frame {
                Frame::Message(raw) => (0, raw.bytes),
                Frame::End(value) => (2, serde_json::to_vec(&*value)?),
            };
            bytes.push(flag);
            bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            bytes.extend(payload);
        }
        send.send_data(bytes.into(), end)?;
        Ok(())
    }
    fn successful_response(response: &mut h2::server::SendResponse<bytes::Bytes>) -> Result<()> {
        let mut send = response.send_response(http::Response::new(()), false)?;
        send_frames(
            &mut send,
            vec![
                update(pb::interaction_update::Message::TextDelta(
                    pb::TextDeltaUpdate {
                        text: "recovered".into(),
                    },
                )),
                update(pb::interaction_update::Message::TurnEnded(
                    pb::TurnEndedUpdate {},
                )),
                Frame::end(json!({})),
            ],
            true,
        )
    }
    fn assert_success(events: &[Value]) {
        assert!(events
            .iter()
            .any(|e| e["type"] == "text-delta" && e["delta"] == "recovered"));
        assert_eq!(
            events.last().expect("test fixture value")["finishReason"]["unified"],
            "stop"
        );
        assert!(!events
            .iter()
            .any(|e| e["type"] == "error" || e["type"] == "tool-call"));
    }
    fn saved_record(engine: &Engine, scope: &str) -> Result<Record> {
        let slots = engine.inner.slots.lock().map_err(|_| anyhow!("lock"))?;
        let slot = slots.get(scope).ok_or_else(|| anyhow!("Missing scope"))?;
        slot.journal
            .as_ref()
            .ok_or_else(|| anyhow!("Missing journal"))?
            .load(slot.binding)?
            .ok_or_else(|| anyhow!("Missing record"))
    }
    async fn shutdown_actor(engine: &Engine, scope: &str) -> Result<()> {
        let jobs = engine.inner.slots.lock().map_err(|_| anyhow!("lock"))?[scope]
            .jobs
            .clone();
        engine.shutdown();
        time::timeout(Duration::from_secs(2), jobs.closed()).await?;
        // A closed receiver has dropped the Session and its journal lock.
        Ok(())
    }
    #[test]
    fn scope_binding_and_finished_lease_cannot_unlock_a_new_request() -> Result<()> {
        let mut i = input()?;
        validate_input(&i)?;
        let b = binding(&i, "http://127.0.0.1:9");
        i.workspace = "/other".into();
        assert_ne!(b, binding(&i, "http://127.0.0.1:9"));
        i.workspace = "relative".into();
        assert!(validate_input(&i).is_err());
        i.scope = "../bad".into();
        assert!(validate_input(&i).is_err());
        let busy = Arc::new(AtomicBool::new(true));
        let (o, stream, _) = output(busy.clone(), CancellationToken::new());
        let lease = Lease(o.control.clone());
        o.control.complete();
        busy.store(true, Ordering::Release);
        drop(lease);
        assert!(busy.load(Ordering::Acquire));
        stream.cancel();
        assert!(!o.control.cancel.is_cancelled());
        Ok(())
    }
    #[test]
    fn structured_model_binding_is_order_independent_and_mode_isolated() -> Result<()> {
        use crate::types::ModelParameter;
        let mut i = input()?;
        let legacy = binding(&i, "http://127.0.0.1:9");
        i.model_parameters = vec![
            ModelParameter {
                id: "reasoning".into(),
                value: "high".into(),
            },
            ModelParameter {
                id: "context".into(),
                value: "large".into(),
            },
        ];
        let configured = binding(&i, "http://127.0.0.1:9");
        assert_ne!(legacy, configured);
        i.model_parameters.reverse();
        assert_eq!(configured, binding(&i, "http://127.0.0.1:9"));
        i.max_mode = true;
        assert_ne!(configured, binding(&i, "http://127.0.0.1:9"));
        i.max_mode = false;
        i.model_parameters[0].value = "different".into();
        assert_ne!(configured, binding(&i, "http://127.0.0.1:9"));
        i.model_parameters.push(i.model_parameters[0].clone());
        assert!(validate_input(&i).is_err());
        Ok(())
    }
    #[tokio::test]
    async fn content_blocks_do_not_share_numeric_tool_identity_namespace() -> Result<()> {
        let (mut o, stream, _) = output(Arc::new(AtomicBool::new(true)), CancellationToken::new());
        o.delta("text", "hello".into())
            .await
            .map_err(|m| anyhow!(m))?;
        o.delta("reasoning", "think".into())
            .await
            .map_err(|m| anyhow!(m))?;
        o.tool(&PendingTool {
            exec_id: "exec".into(),
            exec_message_id: 1,
            tool_call_id: "1".into(),
            name: "read".into(),
            input: json!({}),
        })
        .await
        .map_err(|m| anyhow!(m))?;
        o.finish(true).await.map_err(|m| anyhow!(m))?;
        drop(o);
        let events = collect(&stream).await?;
        let text_id = events
            .iter()
            .find(|e| e["type"] == "text-start")
            .expect("text")["id"]
            .as_str()
            .expect("id");
        let reasoning_id = events
            .iter()
            .find(|e| e["type"] == "reasoning-start")
            .expect("reasoning")["id"]
            .as_str()
            .expect("id");
        assert!(
            text_id.starts_with("cursor-native:text:")
                && reasoning_id.starts_with("cursor-native:reasoning:")
        );
        assert_ne!(text_id, reasoning_id);
        assert_ne!(text_id, "1");
        assert_ne!(reasoning_id, "1");
        assert!(events
            .iter()
            .any(|e| e["type"] == "tool-call" && e["toolCallId"] == "1"));
        Ok(())
    }
    #[tokio::test]
    async fn changed_known_name_arguments_and_results_reject_atomically_without_losing_park(
    ) -> Result<()> {
        for completed in [false, true] {
            for changed in ["name", "input", "output", "provider-executed", "duplicate"] {
                let (mut s, mut i) = pending_session()?;
                let done = json!({"type":"text","value":"DONE_ONCE"});
                if completed {
                    let pending = s.record.pending.remove("call").expect("pending");
                    s.record.completed.insert(
                        "call".into(),
                        Completed {
                            tool: pending.tool,
                            output: done.clone(),
                        },
                    );
                    s.record.lineage.as_mut().expect("lineage").awaiting_results = false;
                }
                let (rpc, _incoming, mut outgoing) = fake_rpc();
                let cancel = rpc.cancel.clone();
                s.rpc = Some(rpc);
                // This valid import precedes the bad known ID: it too must not
                // escape into the ledger on a later validation failure.
                append_result(&mut i, "historical", "read", json!({"x":1}), done.clone());
                append_result(&mut i, "call", "read", json!({}), done.clone());
                let index = i.prompt.len() - 2;
                match changed {
                    "name" => i.prompt[index]["content"][0]["toolName"] = json!("write"),
                    "input" => i.prompt[index]["content"][0]["input"] = json!({"different":true}),
                    "output" if completed => {
                        i.prompt[index + 1]["content"][0]["output"] =
                            json!({"type":"text","value":"CHANGED"})
                    }
                    "output" => {
                        // A result for an unexposed identity is not evidence of
                        // execution and cannot create a quiescent rebuild point.
                        s.record.pending.get_mut("call").expect("pending").exposed = false;
                    }
                    "provider-executed" => {
                        i.prompt[index]["content"][0]["providerExecuted"] = json!(true)
                    }
                    "duplicate" => i.prompt.push(i.prompt[index].clone()),
                    _ => unreachable!(),
                }
                let before = s.record.clone();
                let (j, _stream) = job(i, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
                assert!(s.reconcile(&j).await.is_err(), "{completed} {changed}");
                assert_eq!(s.record.pending.len(), before.pending.len());
                assert_eq!(s.record.completed.len(), before.completed.len());
                assert_eq!(
                    s.record.lineage.as_ref().expect("lineage").history,
                    before.lineage.as_ref().expect("lineage").history
                );
                assert_eq!(s.record.checkpoint, before.checkpoint);
                assert_eq!(s.record.conversation, before.conversation);
                assert!(!cancel.is_cancelled() && outgoing.try_recv().is_err());
                assert!(!s.record.completed.contains_key("historical"));
            }
        }
        Ok(())
    }
    #[tokio::test]
    async fn pending_rewrites_require_all_exposed_exact_calls_results_and_clean_provenance(
    ) -> Result<()> {
        for mutation in ["rewind", "compaction", "branch"] {
            for live in [false, true] {
                let (mut s, mut i) = pending_session()?;
                let old_conversation = s.record.conversation.clone();
                let cancel = if live {
                    let (rpc, _incoming, _outgoing) = fake_rpc();
                    let cancel = rpc.cancel.clone();
                    s.rpc = Some(rpc);
                    Some(cancel)
                } else {
                    None
                };
                match mutation {
                    "rewind" => i.prompt.clear(),
                    "compaction" => {
                        i.prompt = vec![
                            json!({"role":"system","content":"Compacted authoritative host summary"}),
                            json!({"role":"user","content":"New compacted context"}),
                        ]
                    }
                    "branch" => {
                        i.prompt[0]["content"] = json!("Different branch of the same session")
                    }
                    _ => unreachable!(),
                }
                append_result(
                    &mut i,
                    "call",
                    "read",
                    json!({}),
                    json!({"type":"text","value":"KNOWN"}),
                );
                let (j, _stream) = job(i.clone(), Arc::new(AtomicBool::new(true)), s.stop.clone())?;
                assert_eq!(s.reconcile(&j).await?.len(), 1);
                assert!(s.rpc.is_none() && s.record.pending.is_empty());
                assert!(!s.record.in_flight && !s.record.had_actions && !s.recovery_fence);
                assert!(s.record.checkpoint.is_empty());
                assert_ne!(s.record.conversation, old_conversation);
                assert_eq!(
                    s.record.completed["call"].output,
                    json!({"type":"text","value":"KNOWN"})
                );
                assert_eq!(
                    s.record.lineage.as_ref().expect("lineage").history,
                    transcript_proof(&i)?.history
                );
                if let Some(cancel) = cancel {
                    assert!(cancel.is_cancelled());
                }
            }
        }
        for unsafe_state in [
            "missing-call",
            "missing-result",
            "unexposed",
            "partial-output",
            "uncertain-wire",
            "already-sent",
            "missing-lineage",
            "invalid-tools",
        ] {
            let (mut s, mut i) = pending_session()?;
            append_result(
                &mut i,
                "call",
                "read",
                json!({}),
                json!({"type":"text","value":"KNOWN"}),
            );
            i.prompt.push(
                json!({"role":"user","content":"This steering must not be silently ignored"}),
            );
            match unsafe_state {
                "missing-call" => {
                    i.prompt.remove(1);
                }
                "missing-result" => {
                    i.prompt.remove(2);
                }
                "unexposed" => {
                    s.record.pending.get_mut("call").expect("pending").exposed = false;
                }
                "partial-output" => {
                    s.record.lineage.as_mut().expect("lineage").output_pending = true;
                }
                "uncertain-wire" => {
                    s.record.lineage.as_mut().expect("lineage").tainted = true;
                }
                "already-sent" => {
                    s.record.lineage.as_mut().expect("lineage").awaiting_results = false;
                }
                "missing-lineage" => {
                    s.record.lineage = None;
                }
                "invalid-tools" => {
                    i.tools.push(i.tools[0].clone());
                }
                _ => unreachable!(),
            }
            let (rpc, _incoming, _outgoing) = fake_rpc();
            let cancel = rpc.cancel.clone();
            s.rpc = Some(rpc);
            let before = s.record.clone();
            let (j, _stream) = job(i, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
            assert!(s.reconcile(&j).await.is_err(), "{unsafe_state}");
            assert_eq!(s.record.pending.len(), before.pending.len());
            assert_eq!(s.record.completed.len(), before.completed.len());
            assert_eq!(s.record.checkpoint, before.checkpoint);
            assert!(!cancel.is_cancelled());
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn frozen_held_permit_kv_is_committed_without_obsolete_uploads() -> Result<()> {
        for set in [true, false] {
            let tmp = tempfile::tempdir()?;
            let mut s = session()?;
            s.record.had_actions = true;
            s.journal = Some(Journal::open(
                &tmp.path().canonicalize()?.join("recovery"),
                &s.record.scope,
            )?);
            s.context.blobs.insert("01".into(), b"existing".to_vec());
            s.persist()?;
            let path = tmp
                .path()
                .canonicalize()?
                .join("recovery")
                .join(format!("{}.bin", s.record.scope));
            let committed = std::fs::read(&path)?;
            let (rpc, incoming, outgoing) = fake_rpc();
            let cancelled = rpc.cancel.clone();
            let permit = incoming.reserve_owned().await?;
            s.rpc = Some(rpc);
            let frame = server(pb::agent_server_message::Message::KvServerMessage(
                pb::KvServerMessage {
                    id: 17,
                    message: Some(if set {
                        pb::kv_server_message::Message::SetBlobArgs(pb::SetBlobArgs {
                            blob_id: vec![1],
                            blob_data: b"safe bookkeeping".to_vec(),
                        })
                    } else {
                        pb::kv_server_message::Message::GetBlobArgs(pb::GetBlobArgs {
                            blob_id: vec![1],
                        })
                    }),
                    ..Default::default()
                },
            ));
            let producer = tokio::spawn(async move {
                cancelled.cancelled().await;
                // Exactly the audited ordering: driver drops outgoing before
                // handing off the frame whose receive permit predates freeze.
                drop(outgoing);
                drop(permit.send(Ok(frame)));
            });
            s.drain_parked(true).await?;
            producer.await?;
            assert!(!s.blocked);
            assert!(s.rpc.is_none());
            let saved = s
                .journal
                .as_ref()
                .expect("journal")
                .load(s.record.binding)?
                .expect("record");
            assert!(saved.had_actions);
            assert_eq!(
                saved.blobs["01"],
                if set {
                    b"safe bookkeeping".to_vec()
                } else {
                    b"existing".to_vec()
                }
            );
            // A read changes no durable state, so it must not cost a commit either.
            assert_eq!(std::fs::read(&path)? == committed, !set);
        }
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn live_kv_reads_answer_without_a_commit_and_writes_commit_before_ack() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("recovery");
        let mut s = session()?;
        s.journal = Some(Journal::open(&root, &s.record.scope)?);
        s.context.blobs.insert("01".into(), b"existing".to_vec());
        s.persist()?;
        let path = root.join(format!("{}.bin", s.record.scope));
        let (rpc, _incoming, mut outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        let (mut output, _stream, _) =
            output(Arc::new(AtomicBool::new(true)), CancellationToken::new());
        let kv = |message| {
            server(pb::agent_server_message::Message::KvServerMessage(
                pb::KvServerMessage {
                    id: 3,
                    message: Some(message),
                    ..Default::default()
                },
            ))
        };
        let Frame::Message(get) = kv(pb::kv_server_message::Message::GetBlobArgs(
            pb::GetBlobArgs { blob_id: vec![1] },
        )) else {
            bail!("fixture frame")
        };
        let committed = std::fs::read(&path)?;
        s.actions(&get, Some(&mut output))
            .await
            .map_err(|e| anyhow!(e))?;
        assert!(outgoing.try_recv().is_ok(), "read answered");
        assert_eq!(std::fs::read(&path)?, committed, "a read must not commit");
        let Frame::Message(set) = kv(pb::kv_server_message::Message::SetBlobArgs(
            pb::SetBlobArgs {
                blob_id: vec![2],
                blob_data: b"new".to_vec(),
            },
        )) else {
            bail!("fixture frame")
        };
        s.actions(&set, Some(&mut output))
            .await
            .map_err(|e| anyhow!(e))?;
        assert!(outgoing.try_recv().is_ok(), "write acknowledged");
        let saved = s
            .journal
            .as_ref()
            .expect("journal")
            .load(s.record.binding)?
            .expect("record");
        assert_eq!(saved.blobs["02"], b"new".to_vec());
        Ok(())
    }

    fn blob_write(id: u32, blob: u8) -> Frame {
        server(pb::agent_server_message::Message::KvServerMessage(
            pb::KvServerMessage {
                id,
                message: Some(pb::kv_server_message::Message::SetBlobArgs(
                    pb::SetBlobArgs {
                        blob_id: vec![blob],
                        blob_data: vec![blob; 4],
                    },
                )),
                ..Default::default()
            },
        ))
    }
    fn kv_ack_ids(outgoing: &mut mpsc::Receiver<resource::Payload>) -> Result<Vec<u32>> {
        let mut ids = Vec::new();
        while let Ok(payload) = outgoing.try_recv() {
            match pb::AgentClientMessage::decode(payload.as_slice())?.message {
                Some(pb::agent_client_message::Message::KvClientMessage(kv)) => ids.push(kv.id),
                other => bail!("unexpected upload {other:?}"),
            }
        }
        Ok(ids)
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn queued_live_writes_share_one_commit_before_ordered_acks() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let mut s = session()?;
        s.journal = Some(Journal::open(
            &tmp.path().canonicalize()?.join("recovery"),
            &s.record.scope,
        )?);
        s.persist()?;
        let journal = s.journal.clone().expect("journal");
        let base = journal.commits_for_test();
        let (rpc, incoming, mut outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        for frame in [
            blob_write(1, 1),
            blob_write(2, 2),
            server(
                pb::agent_server_message::Message::ConversationCheckpointUpdate(
                    metadata_checkpoint(),
                ),
            ),
        ] {
            incoming.send(Ok(frame)).await?;
        }
        let (mut job, _stream) = job(
            input()?,
            Arc::new(AtomicBool::new(true)),
            CancellationToken::new(),
        )?;
        assert!(matches!(
            s.attempt(&mut job.output, Duration::from_millis(200)).await,
            Attempt::Lost(false)
        ));
        assert_eq!(journal.commits_for_test() - base, 1, "one commit per batch");
        assert_eq!(kv_ack_ids(&mut outgoing)?, vec![1, 2]);
        let saved = journal.load(s.record.binding)?.expect("record");
        assert_eq!(saved.blobs.len(), 2);
        assert_eq!(saved.checkpoint, s.record.checkpoint);
        assert!(!saved.checkpoint.is_empty());
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn deferred_batches_flush_before_count_or_reply_bytes_can_grow_without_bound(
    ) -> Result<()> {
        for large_reply in [false, true] {
            let tmp = tempfile::tempdir()?;
            let mut s = session()?;
            s.journal = Some(Journal::open(
                &tmp.path().canonicalize()?.join("recovery"),
                &s.record.scope,
            )?);
            if large_reply {
                s.context
                    .blobs
                    .insert("42".into(), vec![9; MAX_DEFERRED_REPLY_BYTES]);
                s.resident.resize(s.resident_bytes())?;
            }
            s.persist()?;
            let journal = s.journal.clone().expect("journal");
            let binding = s.record.binding;
            let (mut rpc, incoming, _unused) = fake_rpc();
            // The second acknowledgement cannot complete until the observer has checked
            // how much of the incoming burst remains and inspected its durable record.
            let (tx, mut outgoing) = mpsc::channel(1);
            rpc.outgoing = transport::PayloadSender(tx);
            s.rpc = Some(rpc);
            incoming.send(Ok(blob_write(1, 1))).await?;
            let second = if large_reply {
                server(pb::agent_server_message::Message::KvServerMessage(
                    pb::KvServerMessage {
                        id: 2,
                        message: Some(pb::kv_server_message::Message::GetBlobArgs(
                            pb::GetBlobArgs {
                                blob_id: vec![0x42],
                            },
                        )),
                        ..Default::default()
                    },
                ))
            } else {
                blob_write(2, 2)
            };
            incoming.send(Ok(second)).await?;
            let queued_frames = 2 + 2 * MAX_DEFERRED_FRAMES;
            for _ in 2..queued_frames {
                incoming
                    .send(Ok(update(pb::interaction_update::Message::Heartbeat(
                        pb::HeartbeatUpdate {},
                    ))))
                    .await?;
            }
            let (mut job, _stream) = job(
                input()?,
                Arc::new(AtomicBool::new(true)),
                CancellationToken::new(),
            )?;
            let cancel = job.output.control.cancel.clone();
            let observer = async {
                let observed = async {
                    let first = time::timeout(Duration::from_secs(1), outgoing.recv()).await?
                        .ok_or_else(|| anyhow!("First batch acknowledgement missing"))?;
                    let remaining = incoming.max_capacity() - incoming.capacity();
                    let consumed_limit = if large_reply { 2 } else { MAX_DEFERRED_FRAMES };
                    ensure!(remaining >= queued_frames - consumed_limit,
                        "Deferred batch drained too far before acknowledgement: large_reply={large_reply}, remaining={remaining}");
                    let saved = journal.load(binding)?.expect("committed before ack");
                    assert_eq!(saved.blobs["01"], vec![1; 4]);
                    if !large_reply {
                        assert_eq!(saved.blobs["02"], vec![2; 4]);
                    }
                    let second = time::timeout(Duration::from_secs(1), outgoing.recv()).await?
                        .ok_or_else(|| anyhow!("Second batch acknowledgement missing"))?;
                    let mut ids = Vec::new();
                    for payload in [first, second] {
                        match pb::AgentClientMessage::decode(payload.as_slice())?.message {
                            Some(pb::agent_client_message::Message::KvClientMessage(kv)) => ids.push(kv.id),
                            _ => bail!("Unexpected batch upload"),
                        }
                    }
                    assert_eq!(ids, vec![1, 2], "Acknowledgements stay ordered");
                    anyhow::Ok(())
                }.await;
                cancel.cancel();
                observed
            };
            let (attempt, observed) =
                tokio::join!(s.attempt(&mut job.output, Duration::from_secs(2)), observer);
            observed?;
            assert!(matches!(attempt, Attempt::Fatal("Cursor request aborted")));
        }
        Ok(())
    }
    #[tokio::test]
    async fn an_expired_idle_deadline_does_not_drain_a_ready_deferred_queue() -> Result<()> {
        let mut s = session()?;
        let (rpc, incoming, _outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        s.dirty = true;
        for _ in 0..4 {
            incoming
                .send(Ok(update(pb::interaction_update::Message::Heartbeat(
                    pb::HeartbeatUpdate {},
                ))))
                .await?;
        }
        let before = incoming.capacity();
        let (mut job, _stream) = job(
            input()?,
            Arc::new(AtomicBool::new(true)),
            CancellationToken::new(),
        )?;
        assert!(matches!(
            s.attempt(&mut job.output, Duration::ZERO).await,
            Attempt::Lost(false)
        ));
        assert_eq!(
            incoming.capacity(),
            before,
            "Queued traffic must not bypass an expired deadline"
        );
        assert!(!s.dirty);
        Ok(())
    }
    #[tokio::test]
    async fn a_continuously_refilled_liveness_queue_cannot_hold_a_write_ack_or_extend_idle(
    ) -> Result<()> {
        let mut s = session()?;
        let (rpc, incoming, mut outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        incoming.send(Ok(blob_write(1, 1))).await?;
        for _ in 1..incoming.max_capacity() {
            incoming
                .send(Ok(update(pb::interaction_update::Message::Heartbeat(
                    pb::HeartbeatUpdate {},
                ))))
                .await?;
        }
        let refill = tokio::spawn(async move {
            loop {
                if incoming
                    .send(Ok(update(pb::interaction_update::Message::Heartbeat(
                        pb::HeartbeatUpdate {},
                    ))))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let (mut job, _stream) = job(
            input()?,
            Arc::new(AtomicBool::new(true)),
            CancellationToken::new(),
        )?;
        let result = time::timeout(
            Duration::from_secs(1),
            s.attempt(&mut job.output, Duration::from_millis(40)),
        )
        .await;
        refill.abort();
        let _ = refill.await;
        let attempt = result.map_err(|_| anyhow!("Queued liveness bypassed the idle deadline"))?;
        assert!(matches!(attempt, Attempt::Lost(false)));
        assert_eq!(kv_ack_ids(&mut outgoing)?, vec![1]);
        assert!(!s.dirty && s.acks.is_empty());
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn a_failed_batch_commit_sends_no_acknowledgement() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let mut s = session()?;
        s.journal = Some(Journal::open(
            &tmp.path().canonicalize()?.join("recovery"),
            &s.record.scope,
        )?);
        s.persist()?;
        let (rpc, incoming, mut outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        incoming.send(Ok(blob_write(1, 1))).await?;
        incoming.send(Ok(blob_write(2, 2))).await?;
        let quota = s.journal.as_ref().expect("journal").hold_quota_for_test()?;
        let (mut job, _stream) = job(
            input()?,
            Arc::new(AtomicBool::new(true)),
            CancellationToken::new(),
        )?;
        assert!(matches!(
            s.attempt(&mut job.output, Duration::from_millis(200)).await,
            Attempt::Fatal(_)
        ));
        drop(quota);
        assert!(
            kv_ack_ids(&mut outgoing)?.is_empty(),
            "no ack without its commit"
        );
        assert!(s.blocked);
        assert_eq!(s.capacity, Some("cache_root_busy"));
        Ok(())
    }
    #[tokio::test]
    async fn a_lone_live_write_is_acknowledged_before_waiting_for_more_frames() -> Result<()> {
        let mut s = session()?;
        let (rpc, incoming, mut outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        let (mut job, _stream) = job(
            input()?,
            Arc::new(AtomicBool::new(true)),
            CancellationToken::new(),
        )?;
        let driver = async {
            incoming.send(Ok(blob_write(7, 7))).await?;
            let ack = time::timeout(Duration::from_millis(500), outgoing.recv())
                .await?
                .ok_or_else(|| anyhow!("upload closed"))?;
            anyhow::Ok(ack)
        };
        let (attempt, ack) =
            tokio::join!(s.attempt(&mut job.output, Duration::from_secs(1)), driver);
        let ack = ack?;
        assert!(matches!(
            pb::AgentClientMessage::decode(ack.as_slice())?.message,
            Some(pb::agent_client_message::Message::KvClientMessage(
                pb::KvClientMessage { id: 7, .. }
            ))
        ));
        assert!(matches!(attempt, Attempt::Lost(false)));
        Ok(())
    }

    #[tokio::test]
    async fn frozen_invalid_kv_and_unknown_tools_still_taint() -> Result<()> {
        for frame in [
            server(pb::agent_server_message::Message::KvServerMessage(
                pb::KvServerMessage {
                    id: 1,
                    message: Some(pb::kv_server_message::Message::GetBlobArgs(
                        pb::GetBlobArgs { blob_id: vec![9] },
                    )),
                    ..Default::default()
                },
            )),
            Frame::message(tool_message("unknown")),
            update(pb::interaction_update::Message::TextDelta(
                pb::TextDeltaUpdate {
                    text: "lost output".into(),
                },
            )),
        ] {
            let (mut s, _) = pending_session()?;
            let (rpc, incoming, outgoing) = fake_rpc();
            incoming.send(Ok(frame)).await?;
            drop(incoming);
            drop(outgoing);
            s.rpc = Some(rpc);
            assert!(s.drain_parked(true).await.is_err());
            assert!(s.blocked);
            assert!(s.record.lineage.as_ref().expect("lineage").tainted);
        }
        Ok(())
    }

    #[tokio::test]
    async fn queued_and_in_progress_parked_frames_cannot_be_discarded_by_rebuild() -> Result<()> {
        for kind in ["text", "tool"] {
            for in_progress in [false, true] {
                let (mut s, mut i) = pending_session()?;
                let (rpc, incoming, mut outgoing) = fake_rpc();
                s.rpc = Some(rpc);
                let message = if kind == "tool" {
                    Frame::message(tool_message("late-unexposed"))
                } else {
                    update(pb::interaction_update::Message::TextDelta(
                        pb::TextDeltaUpdate {
                            text: "unaccounted parked output".into(),
                        },
                    ))
                };
                let writer = if in_progress {
                    // A sender already holding a permit may complete even after
                    // Receiver::close(). The freeze must await/drain it too.
                    let permit = incoming.reserve_owned().await?;
                    Some(tokio::spawn(async move {
                        tokio::task::yield_now().await;
                        permit.send(Ok(message));
                    }))
                } else {
                    incoming.send(Ok(message)).await?;
                    None
                };
                append_result(
                    &mut i,
                    "call",
                    "read",
                    json!({}),
                    json!({"type":"text","value":"KNOWN_RESULT"}),
                );
                i.prompt.push(json!({"role":"user","content":"New steering would otherwise trigger a rebuild"}));
                let (j, _stream) = job(i, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
                assert!(
                    s.reconcile(&j).await.is_err(),
                    "{kind}, held permit={in_progress}"
                );
                if let Some(writer) = writer {
                    writer.await?;
                }
                assert!(s.record.completed.is_empty());
                assert!(s.record.pending["call"].exposed);
                assert_eq!(s.record.checkpoint, metadata_checkpoint().encode_to_vec());
                if kind == "tool" {
                    assert!(s
                        .record
                        .pending
                        .get("late-unexposed")
                        .is_none_or(|p| !p.exposed));
                } else {
                    assert!(s.record.lineage.as_ref().expect("lineage").tainted);
                    assert!(s.blocked);
                }
                while let Ok(raw) = outgoing.try_recv() {
                    assert!(
                        !matches!(
                            pb::AgentClientMessage::decode(raw.as_slice())?.message,
                            Some(pb::agent_client_message::Message::ExecClientMessage(_))
                        ),
                        "A newly supplied result escaped before validation"
                    );
                }
            }
        }
        Ok(())
    }
    #[tokio::test]
    async fn checkpoint_restore_rejects_result_only_or_missing_provenance_before_consumption(
    ) -> Result<()> {
        for missing_lineage in [false, true] {
            let (mut s, mut i) = pending_session()?;
            if missing_lineage {
                s.record.lineage = None;
            }
            append_result(
                &mut i,
                "call",
                "read",
                json!({}),
                json!({"type":"text","value":"EXACT_RESULT"}),
            );
            if !missing_lineage {
                i.prompt.remove(1);
            } // live-only result compatibility is not a restore proof
            let before = s.record.clone();
            let (j, _stream) = job(i, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
            assert!(s.reconcile(&j).await.is_err());
            assert_eq!(s.record.pending.len(), before.pending.len());
            assert!(s.record.completed.is_empty());
            assert_eq!(s.record.checkpoint, before.checkpoint);
        }
        // A completed old record is migratable, but opaque checkpoint metadata
        // without lineage is discarded rather than silently trusted.
        let mut s = session()?;
        s.record.checkpoint = metadata_checkpoint().encode_to_vec();
        let original = s.record.conversation.clone();
        let old = PendingTool {
            exec_id: "old-exec".into(),
            exec_message_id: 9,
            tool_call_id: "old".into(),
            name: "read".into(),
            input: json!({}),
        };
        s.record.completed.insert(
            "old".into(),
            Completed {
                tool: old,
                output: json!({"type":"text","value":"KEEP_LEDGER"}),
            },
        );
        let (j, _stream) = job(input()?, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
        s.reconcile(&j).await?;
        assert!(s.record.checkpoint.is_empty() && s.record.lineage.is_some());
        assert_ne!(s.record.conversation, original);
        assert_eq!(
            s.record.completed["old"].output,
            json!({"type":"text","value":"KEEP_LEDGER"})
        );
        Ok(())
    }
    #[tokio::test]
    async fn active_scope_rejects_concurrency_and_binding_changes() -> Result<()> {
        let e = Engine::new()?;
        let i = input()?;
        let route = agent_url(i.agent_url.as_deref())?;
        let (tx, mut rx) = mpsc::channel(1);
        let stop = e.inner.stop.child_token();
        e.inner.slots.lock().map_err(|_| anyhow!("lock"))?.insert(
            i.scope.clone(),
            Slot {
                binding: binding(&i, &route),
                root: None,
                journal: None,
                busy: Arc::new(AtomicBool::new(false)),
                stop,
                jobs: tx,
            },
        );
        let stream = e.start(i.clone(), "fixture-token".into()).await?;
        assert!(e.start(i.clone(), "fixture-token".into()).await.is_err());
        let mut other = i;
        other.workspace = "/other".into();
        assert!(e.start(other, "fixture-token".into()).await.is_err());
        stream.cancel();
        drop(rx.recv().await);
        e.shutdown();
        Ok(())
    }
    #[tokio::test]
    async fn optional_model_metadata_uses_unary_fixture_and_failures_stay_text_only() -> Result<()>
    {
        for outcome in ["success", "http-error", "corrupt", "timeout"] {
            let mut fixture = RpcFixture::new().await?;
            let engine = Engine::new()?;
            let discover = {
                let engine = engine.clone();
                let route = fixture.url.clone();
                tokio::spawn(
                    async move { engine.models("fixture-token".into(), Some(route)).await },
                )
            };
            basic_model_response(&mut fixture).await?;
            let (request, mut response) = fixture
                .request_to("/aiserver.v1.AiService/AvailableModels")
                .await?;
            assert_eq!(
                request.uri().path(),
                "/aiserver.v1.AiService/AvailableModels"
            );
            assert_eq!(
                request.headers()[http::header::AUTHORIZATION],
                "Bearer fixture-token"
            );
            assert_eq!(
                unary_body(request.into_body()).await?,
                vec![0x28, 0x01, 0x38, 0x01]
            );
            match outcome {
                "success" => unary_response(&mut response, metadata_image_fixture())?,
                "http-error" => {
                    response
                        .send_response(http::Response::builder().status(503).body(())?, true)?;
                }
                "corrupt" => unary_response(&mut response, vec![0xff])?,
                "timeout" => {}
                _ => unreachable!(),
            }
            let rows = time::timeout(Duration::from_millis(METADATA_TIMEOUT_MS + 1_000), discover)
                .await???;
            assert_eq!(rows.as_array().expect("array").len(), 1);
            assert_eq!(rows[0]["id"], "default");
            if outcome == "success" {
                assert_eq!(rows[0]["supportsImages"], true);
                assert_eq!(rows[0]["parameterized"]["name"], "default");
                assert_eq!(rows[0]["parameterized"]["variants"], json!([]));
            } else {
                assert_eq!(rows[0]["supportsImages"], false, "{outcome}");
                assert!(rows[0].get("parameterized").is_none());
            }
            engine.shutdown();
            fixture.close().await?;
        }
        Ok(())
    }
    #[tokio::test]
    async fn model_discovery_overlaps_metadata_and_fails_fast_on_the_base_list() -> Result<()> {
        let mut fixture = RpcFixture::new().await?;
        let engine = Engine::new()?;
        let discover = {
            let engine = engine.clone();
            let route = fixture.url.clone();
            tokio::spawn(async move { engine.models("fixture-token".into(), Some(route)).await })
        };
        // Both requests are in flight before either response is sent.
        let (_metadata, _pending) = fixture
            .request_to("/aiserver.v1.AiService/AvailableModels")
            .await?;
        let (_base, mut response) = fixture
            .request_to(&protocol::model_list_request().0)
            .await?;
        response.send_response(http::Response::builder().status(503).body(())?, true)?;
        // The unanswered metadata request must not hold the base failure for its timeout.
        assert!(
            time::timeout(Duration::from_millis(METADATA_TIMEOUT_MS / 2), discover)
                .await??
                .is_err()
        );
        engine.shutdown();
        fixture.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn shutdown_during_optional_model_metadata_is_not_swallowed_as_fallback() -> Result<()> {
        let mut fixture = RpcFixture::new().await?;
        let engine = Engine::new()?;
        let discover = {
            let engine = engine.clone();
            let route = fixture.url.clone();
            tokio::spawn(async move { engine.models("fixture-token".into(), Some(route)).await })
        };
        basic_model_response(&mut fixture).await?;
        let (request, _response) = fixture
            .request_to("/aiserver.v1.AiService/AvailableModels")
            .await?;
        assert_eq!(
            request.uri().path(),
            "/aiserver.v1.AiService/AvailableModels"
        );
        engine.shutdown();
        assert!(time::timeout(Duration::from_secs(1), discover)
            .await??
            .is_err());
        fixture.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn cancellation_aborts_pending_receive_and_releases_scope() -> Result<()> {
        let mut s = session()?;
        let (rpc, _incoming, _outgoing) = fake_rpc();
        let cancel = rpc.cancel.clone();
        s.rpc = Some(rpc);
        let stop = s.stop.clone();
        let busy = Arc::new(AtomicBool::new(true));
        let (j, stream) = job(input()?, busy.clone(), stop.clone())?;
        let (tx, rx) = mpsc::channel(1);
        tx.send(j).await.map_err(|_| anyhow!("fixture"))?;
        let task = tokio::spawn(s.run(rx));
        assert_eq!(
            stream.next().await.ok_or_else(|| anyhow!("metadata"))?["type"],
            "response-metadata"
        );
        stream.cancel();
        let events = collect(&stream).await?;
        assert!(events.iter().any(|e| e["type"] == "error"));
        assert!(cancel.is_cancelled());
        assert!(!busy.load(Ordering::Acquire));
        stop.cancel();
        task.await?;
        Ok(())
    }
    #[tokio::test]
    async fn tool_finish_parks_rpc_and_matching_result_uses_same_exec() -> Result<()> {
        let mut s = session()?;
        s.record.in_flight = true;
        let tools = vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})];
        s.context.tools = tools.clone();
        let (rpc, incoming, mut outgoing) = fake_rpc();
        let rpc_cancel = rpc.cancel.clone();
        s.rpc = Some(rpc);
        let stop = s.stop.clone();
        let busy = Arc::new(AtomicBool::new(true));
        let mut i = input()?;
        i.tools = tools;
        let (j, first) = job(i.clone(), busy.clone(), stop.clone())?;
        let (tx, rx) = mpsc::channel(1);
        tx.send(j).await.map_err(|_| anyhow!("fixture"))?;
        let task = tokio::spawn(s.run(rx));
        incoming
            .send(Ok(Frame::message(tool_message("call"))))
            .await?;
        let events = collect(&first).await?;
        assert_eq!(
            events.last().ok_or_else(|| anyhow!("finish"))?["finishReason"]["unified"],
            "tool-calls"
        );
        assert!(events
            .iter()
            .any(|e| e["type"] == "tool-call" && e["providerExecuted"] == false));
        first.cancel();
        assert!(!rpc_cancel.is_cancelled());
        // A mismatched ID must neither consume pending state nor stop the park.
        i.prompt.push(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"wrong","output":{"type":"text","value":"done"}}]}));
        busy.store(true, Ordering::Release);
        let (bad, bad_stream) = job(i.clone(), busy.clone(), stop.clone())?;
        tx.send(bad).await.map_err(|_| anyhow!("fixture"))?;
        assert!(collect(&bad_stream)
            .await?
            .iter()
            .any(|e| e["type"] == "error"));
        assert!(!rpc_cancel.is_cancelled());
        i.prompt.pop();
        i.prompt.push(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"call","output":{"type":"text","value":"DONE_ONCE"}}]}));
        busy.store(true, Ordering::Release);
        let (next, second) = job(i, busy, stop.clone())?;
        tx.send(next).await.map_err(|_| anyhow!("fixture"))?;
        let result = time::timeout(Duration::from_secs(1), outgoing.recv())
            .await?
            .ok_or_else(|| anyhow!("result"))?;
        let result = pb::AgentClientMessage::decode(result.as_slice())?;
        assert!(
            matches!(result.message, Some(pb::agent_client_message::Message::ExecClientMessage(m)) if m.id == 7 && m.exec_id == "exec")
        );
        incoming
            .send(Ok(update(pb::interaction_update::Message::TextDelta(
                pb::TextDeltaUpdate {
                    text: "done".into(),
                },
            ))))
            .await?;
        incoming
            .send(Ok(update(pb::interaction_update::Message::TurnEnded(
                pb::TurnEndedUpdate {},
            ))))
            .await?;
        let events = collect(&second).await?;
        assert_eq!(
            events.last().ok_or_else(|| anyhow!("finish"))?["finishReason"]["unified"],
            "stop"
        );
        assert!(events.iter().any(|e| e["type"] == "text-end"));
        assert!(rpc_cancel.is_cancelled());
        stop.cancel();
        task.await?;
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn parked_steering_registry_system_and_payload_changes_are_delivered_on_a_fresh_rpc(
    ) -> Result<()> {
        for change in ["steering", "registry", "system", "onPayload"] {
            let tmp = tempfile::tempdir()?;
            let mut fixture = RpcFixture::new().await?;
            let engine = Engine::new()?;
            let mut i = input()?;
            i.stateless = false;
            i.cache_dir = Some(
                tmp.path()
                    .canonicalize()?
                    .join("recovery")
                    .to_string_lossy()
                    .into_owned(),
            );
            i.agent_url = Some(fixture.url.clone());
            i.tools = tools();
            let first = engine.start(i.clone(), "fixture-token".into()).await?;
            let (request, mut response) = fixture.request().await?;
            let mut first_body = request.into_body();
            let first_run = run_request(&mut first_body).await?;
            let mut first_send = response.send_response(http::Response::new(()), false)?;
            send_frames(
                &mut first_send,
                vec![
                    server(
                        pb::agent_server_message::Message::ConversationCheckpointUpdate(
                            metadata_checkpoint(),
                        ),
                    ),
                    Frame::message(tool_message("call")),
                ],
                false,
            )?;
            let events = collect(&first).await?;
            assert_eq!(
                events.iter().filter(|e| e["type"] == "tool-call").count(),
                1
            );
            append_result(
                &mut i,
                "call",
                "read",
                json!({}),
                json!({"type":"text","value":"DELIVERED_RESULT"}),
            );
            match change {
                "steering" => i.prompt.push(json!({"role":"user","content":"Follow this new steering, not the previous plan"})),
                "registry" => i.tools.push(json!({"type":"function","name":"write","inputSchema":{"type":"object"}})),
                "system" => i.prompt.insert(0, json!({"role":"system","content":"AUTHORITATIVE_CHANGED_SYSTEM"})),
                "onPayload" => i.prompt[0]["content"] = json!("AUTHORITATIVE_CHANGED_PAYLOAD"),
                _ => unreachable!(),
            }
            let next = engine.start(i.clone(), "fixture-token".into()).await?;
            let (request, mut response) = fixture.request().await?;
            let mut body = request.into_body();
            let run = run_request(&mut body).await?;
            assert_ne!(run.conversation_id, first_run.conversation_id, "{change}");
            let state = run.conversation_state.as_ref().expect("state");
            assert!(
                state.summary.is_none()
                    && state.summary_archive.is_none()
                    && state.extra_state.is_empty()
            );
            assert_eq!(
                time::timeout(
                    Duration::from_secs(2),
                    futures_util::future::poll_fn(|cx| first_send.poll_reset(cx))
                )
                .await??,
                h2::Reason::CANCEL
            );
            // The old result was NOT sent to a peer that never received the new
            // instructions/registry. Its exact identity lives in rebuilt history.
            assert!(first_body.data().await.is_none_or(|result| result.is_err()));
            let record = saved_record(&engine, &i.scope)?;
            assert_eq!(
                record.completed["call"].output,
                json!({"type":"text","value":"DELIVERED_RESULT"})
            );
            assert!(record.checkpoint.is_empty());
            let encoded_history: Vec<_> = record
                .blobs
                .values()
                .filter_map(|v| std::str::from_utf8(v).ok())
                .collect();
            let encoded_history = encoded_history.join("\n");
            assert!(encoded_history.contains("DELIVERED_RESULT"));
            if change == "steering" {
                match run
                    .action
                    .as_ref()
                    .and_then(|action| action.action.as_ref())
                {
                    Some(pb::conversation_action::Action::UserMessageAction(action)) => assert_eq!(
                        action.user_message.as_ref().expect("user").text,
                        "Follow this new steering, not the previous plan"
                    ),
                    _ => bail!("Steering was not delivered as a user action"),
                }
            }
            if change == "system" {
                assert!(encoded_history.contains("AUTHORITATIVE_CHANGED_SYSTEM"));
            }
            if change == "onPayload" {
                assert!(encoded_history.contains("AUTHORITATIVE_CHANGED_PAYLOAD"));
            }
            if change == "registry" {
                assert!(run
                    .mcp_tools
                    .as_ref()
                    .expect("tools")
                    .mcp_tools
                    .iter()
                    .any(|tool| tool.tool_name.ends_with("write")));
                let mut send = response.send_response(http::Response::new(()), false)?;
                send_frames(
                    &mut send,
                    vec![Frame::message(named_tool_message("new-call", "write"))],
                    false,
                )?;
                let events = collect(&next).await?;
                assert!(events.iter().any(|e| e["type"] == "tool-call"
                    && e["toolCallId"] == "new-call"
                    && e["toolName"] == "write"
                    && e["providerExecuted"] == false));
                assert!(!events.iter().any(|e| e["type"] == "error"));
                // The newly activated tool is still host-gated and its result
                // continues on the new park, never the discarded old RPC.
                append_result(
                    &mut i,
                    "new-call",
                    "write",
                    json!({}),
                    json!({"type":"text","value":"HOST_ALLOWED"}),
                );
                let last = engine.start(i.clone(), "fixture-token".into()).await?;
                assert!(matches!(
                    client_message(&mut body).await?.message,
                    Some(pb::agent_client_message::Message::ExecClientMessage(_))
                ));
                send_frames(
                    &mut send,
                    vec![update(pb::interaction_update::Message::TurnEnded(
                        pb::TurnEndedUpdate {},
                    ))],
                    false,
                )?;
                assert!(collect(&last)
                    .await?
                    .iter()
                    .any(|e| e["type"] == "finish" && e["finishReason"]["unified"] == "stop"));
            } else {
                successful_response(&mut response)?;
                assert_success(&collect(&next).await?);
            }
            shutdown_actor(&engine, &i.scope).await?;
            fixture.close().await?;
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn completed_history_rewind_compaction_branch_rotate_but_exact_descendant_keeps_checkpoint(
    ) -> Result<()> {
        for change in ["rewind", "compaction", "branch", "descendant"] {
            let tmp = tempfile::tempdir()?;
            let mut fixture = RpcFixture::new().await?;
            let engine = Engine::new()?;
            let mut i = input()?;
            i.stateless = false;
            i.cache_dir = Some(
                tmp.path()
                    .canonicalize()?
                    .join("recovery")
                    .to_string_lossy()
                    .into_owned(),
            );
            i.agent_url = Some(fixture.url.clone());
            i.prompt
                .insert(0, json!({"role":"user","content":"Previous history"}));
            i.prompt.insert(
                1,
                json!({"role":"assistant","content":[{"type":"text","text":"Previous answer"}]}),
            );
            let first = engine.start(i.clone(), "fixture-token".into()).await?;
            let (request, mut response) = fixture.request().await?;
            let mut body = request.into_body();
            let first_run = run_request(&mut body).await?;
            let mut send = response.send_response(http::Response::new(()), false)?;
            send_frames(
                &mut send,
                vec![
                    server(
                        pb::agent_server_message::Message::ConversationCheckpointUpdate(
                            metadata_checkpoint(),
                        ),
                    ),
                    update(pb::interaction_update::Message::TextDelta(
                        pb::TextDeltaUpdate {
                            text: "recovered".into(),
                        },
                    )),
                    update(pb::interaction_update::Message::TurnEnded(
                        pb::TurnEndedUpdate {},
                    )),
                    Frame::end(json!({})),
                ],
                true,
            )?;
            assert_success(&collect(&first).await?);
            i.prompt
                .push(json!({"role":"assistant","content":[{"type":"text","text":"recovered"}]}));
            match change {
                "rewind" => i.prompt.truncate(1),
                "compaction" => {
                    i.prompt = vec![
                        json!({"role":"system","content":"Compacted host rules"}),
                        json!({"role":"user","content":"Compacted host history"}),
                    ]
                }
                "branch" => i.prompt[2]["content"] = json!("Different branch"),
                "descendant" => {}
                _ => unreachable!(),
            }
            i.prompt
                .push(json!({"role":"user","content":"Continue on the authoritative history"}));
            let next = engine.start(i.clone(), "fixture-token".into()).await?;
            let (request, mut response) = fixture.request().await?;
            let mut body = request.into_body();
            let run = run_request(&mut body).await?;
            let state = run.conversation_state.as_ref().expect("state");
            if change == "descendant" {
                assert_eq!(run.conversation_id, first_run.conversation_id);
                assert_eq!(state.summary, metadata_checkpoint().summary);
                assert_eq!(state.extra_state, b"STALE-OPAQUE");
            } else {
                assert_ne!(run.conversation_id, first_run.conversation_id);
                assert!(
                    state.summary.is_none()
                        && state.summary_archive.is_none()
                        && state.extra_state.is_empty()
                );
            }
            successful_response(&mut response)?;
            assert_success(&collect(&next).await?);
            shutdown_actor(&engine, &i.scope).await?;
            fixture.close().await?;
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn checkpoint_result_continuation_restarts_successfully_with_exact_provenance(
    ) -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let mut fixture = RpcFixture::new().await?;
        let engine = Engine::new()?;
        let mut i = input()?;
        i.stateless = false;
        i.cache_dir = Some(
            tmp.path()
                .canonicalize()?
                .join("recovery")
                .to_string_lossy()
                .into_owned(),
        );
        i.agent_url = Some(fixture.url.clone());
        i.tools = tools();
        let first = engine.start(i.clone(), "fixture-token".into()).await?;
        let (request, mut response) = fixture.request().await?;
        let mut body = request.into_body();
        let original_run = run_request(&mut body).await?;
        let mut send = response.send_response(http::Response::new(()), false)?;
        send_frames(
            &mut send,
            vec![
                server(
                    pb::agent_server_message::Message::ConversationCheckpointUpdate(
                        metadata_checkpoint(),
                    ),
                ),
                update(pb::interaction_update::Message::ThinkingDelta(
                    pb::ThinkingDeltaUpdate {
                        text: "checked ".into(),
                    },
                )),
                update(pb::interaction_update::Message::ThinkingDelta(
                    pb::ThinkingDeltaUpdate {
                        text: "first".into(),
                    },
                )),
                update(pb::interaction_update::Message::TextDelta(
                    pb::TextDeltaUpdate {
                        text: "before the tool".into(),
                    },
                )),
                Frame::message(tool_message("call")),
            ],
            false,
        )?;
        let events = collect(&first).await?;
        assert_eq!(
            events.iter().filter(|e| e["type"] == "tool-call").count(),
            1
        );
        let persisted = saved_record(&engine, &i.scope)?;
        assert!(
            persisted
                .lineage
                .as_ref()
                .expect("lineage")
                .awaiting_results
        );
        assert!(!persisted.lineage.as_ref().expect("lineage").output_pending);
        shutdown_actor(&engine, &i.scope).await?;
        i.prompt.push(json!({"role":"assistant","content":[{"type":"reasoning","text":"checked first"},{"type":"text","text":"before the tool"},{"type":"tool-call","toolCallId":"call","toolName":"read","input":{}}]}));
        i.prompt.push(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"call","output":{"type":"text","value":"EXACT_RESTART_RESULT"}}]}));
        let restarted = Engine::new()?;
        let next = restarted.start(i.clone(), "fixture-token".into()).await?;
        let (request, mut response) = fixture.request().await?;
        let mut body = request.into_body();
        let run = run_request(&mut body).await?;
        assert_eq!(run.conversation_id, original_run.conversation_id);
        assert_eq!(
            run.conversation_state.as_ref().expect("state").summary,
            metadata_checkpoint().summary
        );
        let mut send = response.send_response(http::Response::new(()), false)?;
        send_frames(&mut send, vec![Frame::message(tool_message("call"))], false)?;
        let reply = client_message(&mut body).await?;
        assert!(matches!(
            &reply.message,
            Some(pb::agent_client_message::Message::ExecClientMessage(_))
        ));
        assert!(format!("{reply:?}").contains("EXACT_RESTART_RESULT"));
        send_frames(
            &mut send,
            vec![
                update(pb::interaction_update::Message::TextDelta(
                    pb::TextDeltaUpdate {
                        text: "recovered".into(),
                    },
                )),
                update(pb::interaction_update::Message::TurnEnded(
                    pb::TurnEndedUpdate {},
                )),
            ],
            false,
        )?;
        assert_success(&collect(&next).await?);
        let done = saved_record(&restarted, &i.scope)?;
        assert!(!done.in_flight && !done.had_actions && done.pending.is_empty());
        assert_eq!(
            done.completed["call"].output,
            json!({"type":"text","value":"EXACT_RESTART_RESULT"})
        );
        shutdown_actor(&restarted, &i.scope).await?;
        fixture.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn heartbeats_do_not_postpone_watchdog_or_fabricate_success() -> Result<()> {
        let mut s = session()?;
        let (rpc, incoming, _outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        let stop = s.stop.clone();
        let mut i = input()?;
        i.idle_timeout_ms = Some(100);
        let (j, stream) = job(i, Arc::new(AtomicBool::new(true)), stop.clone())?;
        let (tx, rx) = mpsc::channel(1);
        tx.send(j).await.map_err(|_| anyhow!("fixture"))?;
        let task = tokio::spawn(s.run(rx));
        for _ in 0..12 {
            incoming
                .send(Ok(update(pb::interaction_update::Message::Heartbeat(
                    pb::HeartbeatUpdate {},
                ))))
                .await?;
        }
        let events = collect(&stream).await?;
        assert!(events.iter().any(|e| e["type"] == "error"));
        assert!(!events.iter().any(|e| e["type"] == "finish"));
        stop.cancel();
        task.await?;
        Ok(())
    }
    #[tokio::test]
    async fn eof_after_partial_output_never_blindly_retries() -> Result<()> {
        let mut s = session()?;
        let (rpc, incoming, _outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        let stop = s.stop.clone();
        let (j, stream) = job(input()?, Arc::new(AtomicBool::new(true)), stop.clone())?;
        let (tx, rx) = mpsc::channel(1);
        tx.send(j).await.map_err(|_| anyhow!("fixture"))?;
        let task = tokio::spawn(s.run(rx));
        incoming
            .send(Ok(update(pb::interaction_update::Message::TextDelta(
                pb::TextDeltaUpdate {
                    text: "partial".into(),
                },
            ))))
            .await?;
        incoming.send(Ok(Frame::end(json!({})))).await?;
        let events = collect(&stream).await?;
        assert!(events.iter().any(|e| e["type"] == "error"
            && e["error"]
                .as_str()
                .is_some_and(|s| s.contains("without a checkpoint"))));
        assert!(!events.iter().any(|e| e["type"] == "finish"));
        stop.cancel();
        task.await?;
        Ok(())
    }
    #[tokio::test]
    async fn refresh_is_internal_bounded_and_cancellable_without_token_disclosure() -> Result<()> {
        let mut s = session()?;
        let (rpc, incoming, _outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        let stop = s.stop.clone();
        let mut i = input()?;
        i.max_retries = Some(1);
        let (j, stream) = job(i, Arc::new(AtomicBool::new(true)), stop.clone())?;
        let (tx, rx) = mpsc::channel(1);
        tx.send(j).await.map_err(|_| anyhow!("fixture"))?;
        let task = tokio::spawn(s.run(rx));
        incoming
            .send(Ok(Frame::end(
                json!({"error":{"code":"unauthenticated","message":"DO_NOT_ECHO"}}),
            )))
            .await?;
        assert_eq!(
            stream.next().await.ok_or_else(|| anyhow!("metadata"))?["type"],
            "response-metadata"
        );
        assert_eq!(
            time::timeout(Duration::from_secs(1), stream.next())
                .await?
                .ok_or_else(|| anyhow!("refresh"))?["type"],
            "native-token-refresh"
        );
        stream.set_access_token("private-new-token".into()).await?;
        stream.cancel();
        let events = collect(&stream).await?;
        let text = serde_json::to_string(&events)?;
        assert!(text.contains("aborted"));
        assert!(!text.contains("private-new-token") && !text.contains("DO_NOT_ECHO"));
        stop.cancel();
        task.await?;
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn corrupt_custom_cache_can_be_removed_and_stateless_restart_refuses_resume() -> Result<()>
    {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("recovery");
        let mut i = input()?;
        i.stateless = false;
        i.cache_dir = Some(root.to_string_lossy().into_owned());
        let j = Journal::open(&root, &i.scope)?;
        let record = Record::new(i.scope.clone(), binding(&i, "http://127.0.0.1:9"));
        j.save(&record)?;
        drop(j);
        let path = root.join(format!("{}.bin", i.scope));
        std::fs::write(&path, b"corrupt")?;
        let engine = Engine::new()?;
        assert!(engine
            .start(i.clone(), "fixture-token".into())
            .await
            .is_err());
        engine.remove(&i.scope).await?;
        assert!(!path.exists());
        engine.shutdown();
        let mut s = session()?;
        s.stateless = true;
        i = input()?;
        i.prompt.push(json!({"role":"assistant","content":[{"type":"tool-call","toolCallId":"old","toolName":"read","input":{}}]}));
        i.prompt.push(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"old","output":{"type":"text","value":"already executed"}}]}));
        let (j, _stream) = job(i.clone(), Arc::new(AtomicBool::new(true)), s.stop.clone())?;
        assert!(s.reconcile(&j).await.is_err());
        i.prompt
            .push(json!({"role":"user","content":[{"type":"text","text":"new user turn"}]}));
        let (j, _stream) = job(i, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
        s.reconcile(&j).await?;
        assert!(s.record.completed.contains_key("old"));
        Ok(())
    }
    #[tokio::test]
    async fn cancelled_action_free_request_allows_successful_same_scope_followup() -> Result<()> {
        for partial in [false, true] {
            let mut fixture = RpcFixture::new().await?;
            let engine = Engine::new()?;
            let mut i = input()?;
            i.agent_url = Some(fixture.url.clone());
            let first = engine.start(i.clone(), "fixture-token".into()).await?;
            let (request, mut response) = fixture.request().await?;
            let mut body = request.into_body();
            run_request(&mut body).await?; // in_flight was committed before this real RPC
            let mut send = response.send_response(http::Response::new(()), false)?;
            assert_eq!(
                first.next().await.expect("test fixture value")["type"],
                "response-metadata"
            );
            if partial {
                send_frames(
                    &mut send,
                    vec![update(pb::interaction_update::Message::TextDelta(
                        pb::TextDeltaUpdate {
                            text: "partial".into(),
                        },
                    ))],
                    false,
                )?;
                assert_eq!(
                    first.next().await.expect("test fixture value")["type"],
                    "text-start"
                );
                assert_eq!(
                    first.next().await.expect("test fixture value")["type"],
                    "text-delta"
                );
            }
            first.cancel();
            // Queue immediately, before the old actor's terminal cleanup finishes.
            let next = engine.start(i, "fixture-token".into()).await?;
            assert!(collect(&first).await?.iter().any(|e| e["type"] == "error"));
            assert_eq!(
                time::timeout(
                    Duration::from_secs(2),
                    futures_util::future::poll_fn(|cx| send.poll_reset(cx))
                )
                .await??,
                h2::Reason::CANCEL
            );
            let (request, mut response) = fixture.request().await?;
            let mut next_body = request.into_body();
            run_request(&mut next_body).await?;
            successful_response(&mut response)?;
            assert_success(&collect(&next).await?);
            engine.shutdown();
            fixture.close().await?;
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn eof_retry_exhaustion_and_partial_output_allow_only_explicit_same_scope_recovery(
    ) -> Result<()> {
        // Test both raw EOF and empty successful Connect End: neither is TurnEnded.
        for (connect_end, partial, checkpoint) in [
            (false, false, false),
            (true, false, false),
            (true, true, false),
            (true, true, true),
        ] {
            let tmp = tempfile::tempdir()?;
            let root = tmp.path().canonicalize()?.join("recovery");
            let mut fixture = RpcFixture::new().await?;
            let engine = Engine::new()?;
            let mut i = input()?;
            i.agent_url = Some(fixture.url.clone());
            i.max_retries = Some(if partial { 3 } else { 1 });
            i.stateless = false;
            i.cache_dir = Some(root.to_string_lossy().into_owned());
            let first = engine.start(i.clone(), "fixture-token".into()).await?;
            let attempts = if partial { 1 } else { 2 };
            for _ in 0..attempts {
                let (request, mut response) = fixture.request().await?;
                let mut body = request.into_body();
                run_request(&mut body).await?;
                let mut send = response.send_response(http::Response::new(()), false)?;
                let mut frames = Vec::new();
                if checkpoint {
                    frames.push(server(
                        pb::agent_server_message::Message::ConversationCheckpointUpdate(
                            pb::ConversationStateStructure {
                                mode: Some(1),
                                ..Default::default()
                            },
                        ),
                    ));
                }
                if partial {
                    frames.push(update(pb::interaction_update::Message::TextDelta(
                        pb::TextDeltaUpdate {
                            text: "partial".into(),
                        },
                    )));
                }
                if connect_end {
                    frames.push(Frame::end(json!({})));
                }
                send_frames(&mut send, frames, true)?;
            }
            let events = collect(&first).await?;
            let expected = if partial {
                if checkpoint {
                    "after output"
                } else {
                    "after partial output"
                }
            } else {
                "retry budget exhausted"
            };
            assert!(events.iter().any(|e| e["type"] == "error"
                && e["error"].as_str().is_some_and(|s| s.contains(expected))));
            assert!(!events.iter().any(|e| e["type"] == "finish"));
            assert!(
                fixture.requests.try_recv().is_err(),
                "Partial output must never auto-retry"
            );
            let abandoned = saved_record(&engine, &i.scope)?;
            assert!(!abandoned.in_flight && abandoned.checkpoint.is_empty());
            let engine = if !connect_end {
                // Terminal failure must be recoverable after a process restart too.
                shutdown_actor(&engine, &i.scope).await?;
                Engine::new()?
            } else {
                engine
            };
            let next = engine.start(i, "fixture-token".into()).await?;
            let (request, mut response) = fixture.request().await?;
            let mut body = request.into_body();
            run_request(&mut body).await?;
            successful_response(&mut response)?;
            assert_success(&collect(&next).await?);
            engine.shutdown();
            fixture.close().await?;
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn no_checkpoint_cancellation_persists_abandonment_across_engine_restart_without_losing_ledger(
    ) -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("recovery");
        let mut fixture = RpcFixture::new().await?;
        let mut i = input()?;
        i.agent_url = Some(fixture.url.clone());
        i.stateless = false;
        i.cache_dir = Some(root.to_string_lossy().into_owned());
        let mut record = Record::new(i.scope.clone(), binding(&i, &fixture.url));
        let tool = PendingTool {
            exec_id: "old-exec".into(),
            exec_message_id: 1,
            tool_call_id: "old".into(),
            name: "read".into(),
            input: json!({}),
        };
        record.completed.insert(
            "old".into(),
            Completed {
                tool,
                output: json!({"type":"text","value":"DO_NOT_REPEAT"}),
            },
        );
        let journal = Journal::open(&root, &i.scope)?;
        journal.save(&record)?;
        drop(journal);
        let engine = Engine::new()?;
        let first = engine.start(i.clone(), "fixture-token".into()).await?;
        let (request, mut response) = fixture.request().await?;
        let mut body = request.into_body();
        run_request(&mut body).await?;
        let _send = response.send_response(http::Response::new(()), false)?;
        first.cancel();
        collect(&first).await?;
        let abandoned = saved_record(&engine, &i.scope)?;
        assert!(!abandoned.in_flight && !abandoned.had_actions && abandoned.checkpoint.is_empty());
        assert_ne!(abandoned.conversation, record.conversation);
        assert_eq!(
            abandoned.completed["old"].output,
            record.completed["old"].output
        );
        shutdown_actor(&engine, &i.scope).await?;
        let restarted = Engine::new()?;
        let next = restarted.start(i.clone(), "fixture-token".into()).await?;
        let (request, mut response) = fixture.request().await?;
        let mut next_body = request.into_body();
        run_request(&mut next_body).await?;
        successful_response(&mut response)?;
        assert_success(&collect(&next).await?);
        assert_eq!(
            saved_record(&restarted, &i.scope)?.completed["old"].output,
            record.completed["old"].output
        );
        shutdown_actor(&restarted, &i.scope).await?;
        // Legacy/crash-left action-free in_flight journals are repairable too.
        let journal = Journal::open(&root, &i.scope)?;
        let mut interrupted = journal.load(record.binding)?.expect("test fixture value");
        interrupted.in_flight = true;
        journal.save(&interrupted)?;
        drop(journal);
        let restarted = Engine::new()?;
        let next = restarted.start(i.clone(), "fixture-token".into()).await?;
        let (request, mut response) = fixture.request().await?;
        let mut body = request.into_body();
        run_request(&mut body).await?;
        successful_response(&mut response)?;
        assert_success(&collect(&next).await?);
        assert!(saved_record(&restarted, &i.scope)?
            .completed
            .contains_key("old"));
        shutdown_actor(&restarted, &i.scope).await?;
        fixture.close().await?;
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn cancelled_actionful_continuation_keeps_pending_completed_ids_and_restart_fence(
    ) -> Result<()> {
        for checkpoint in [false, true] {
            let tmp = tempfile::tempdir()?;
            let root = tmp.path().canonicalize()?.join("recovery");
            let mut fixture = RpcFixture::new().await?;
            let engine = Engine::new()?;
            let mut i = input()?;
            i.agent_url = Some(fixture.url.clone());
            i.stateless = false;
            i.cache_dir = Some(root.to_string_lossy().into_owned());
            i.tools =
                vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})];
            let first = engine.start(i.clone(), "fixture-token".into()).await?;
            let (request, mut response) = fixture.request().await?;
            let mut body = request.into_body();
            run_request(&mut body).await?;
            let mut send = response.send_response(http::Response::new(()), false)?;
            let mut frames = Vec::new();
            if checkpoint {
                frames.push(server(
                    pb::agent_server_message::Message::ConversationCheckpointUpdate(
                        pb::ConversationStateStructure {
                            mode: Some(1),
                            ..Default::default()
                        },
                    ),
                ));
            }
            frames.push(Frame::message(tool_message("call")));
            send_frames(&mut send, frames, false)?;
            let events = collect(&first).await?;
            assert_eq!(
                events.iter().filter(|e| e["type"] == "tool-call").count(),
                1
            );
            let pending = saved_record(&engine, &i.scope)?;
            assert!(pending.in_flight && pending.had_actions && pending.pending["call"].exposed);
            // Post-finish cancellation must leave the action context parked.
            first.cancel();
            assert!(saved_record(&engine, &i.scope)?
                .pending
                .contains_key("call"));
            let result = json!({"type":"text","value":"PERFORMED_ONCE"});
            i.prompt.push(json!({"role":"assistant","content":[{"type":"tool-call","toolCallId":"call","toolName":"read","input":{}}]}));
            i.prompt
                .push(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"call","output":result}]}));
            let continuation = engine.start(i.clone(), "fixture-token".into()).await?;
            assert!(
                matches!(client_message(&mut body).await?.message, Some(pb::agent_client_message::Message::ExecClientMessage(m)) if m.id == 7 && m.exec_id == "exec")
            );
            continuation.cancel();
            assert!(collect(&continuation)
                .await?
                .iter()
                .any(|e| e["type"] == "error"));
            let cancelled = saved_record(&engine, &i.scope)?;
            assert!(cancelled.in_flight && cancelled.had_actions && cancelled.pending.is_empty());
            assert_eq!(cancelled.completed["call"].output, result);
            assert_eq!(cancelled.checkpoint, pending.checkpoint);
            shutdown_actor(&engine, &i.scope).await?;
            let restarted = Engine::new()?;
            let next = restarted.start(i.clone(), "fixture-token".into()).await?;
            let events = if checkpoint {
                let (request, mut response) = fixture.request().await?;
                let mut body = request.into_body();
                run_request(&mut body).await?;
                let mut send = response.send_response(http::Response::new(()), false)?;
                send_frames(&mut send, vec![Frame::message(tool_message("call"))], false)?;
                // A known ID replays its recorded result, never another host call.
                assert!(
                    matches!(client_message(&mut body).await?.message, Some(pb::agent_client_message::Message::ExecClientMessage(m)) if m.id == 7 && m.exec_id == "exec")
                );
                send_frames(
                    &mut send,
                    vec![Frame::message(tool_message("unknown"))],
                    false,
                )?;
                collect(&next).await?
            } else {
                collect(&next).await?
            };
            let reason = if checkpoint {
                "unknown tool ID"
            } else {
                "valid checkpoint"
            };
            assert!(
                events.iter().any(|e| e["type"] == "error"
                    && e["error"].as_str().is_some_and(|s| s.contains(reason))),
                "{events:?}"
            );
            assert!(!events
                .iter()
                .any(|e| e["type"] == "tool-call" || e["type"] == "finish"));
            let fenced = saved_record(&restarted, &i.scope)?;
            assert!(fenced.in_flight && fenced.had_actions);
            assert_eq!(fenced.completed["call"].output, result);
            assert!(!fenced.pending.contains_key("unknown"));
            shutdown_actor(&restarted, &i.scope).await?;
            fixture.close().await?;
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn retired_custom_root_reset_and_binding_validation() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("custom-recovery");
        let engine = Engine::new()?;
        let scope = format!("{:064x}", 123);
        let journal = Journal::open(&root, &scope)?;
        let record = Record::new(scope.clone(), [7; 32]);
        journal.save(&record)?;
        let (jobs, rx) = mpsc::channel(1);
        drop(rx);
        engine
            .inner
            .slots
            .lock()
            .map_err(|_| anyhow!("lock"))?
            .insert(
                scope.clone(),
                Slot {
                    binding: record.binding,
                    root: Some(root.clone()),
                    journal: Some(journal),
                    busy: Arc::new(AtomicBool::new(false)),
                    stop: engine.inner.stop.child_token(),
                    jobs,
                },
            );
        let stream = engine.start(input()?, "fixture-token".into()).await?;
        assert!(!engine
            .inner
            .slots
            .lock()
            .map_err(|_| anyhow!("lock"))?
            .contains_key(&scope));
        // Retirement releases the lock/FDs but keeps binding and original root.
        let reopened = Journal::open(&root, &scope)?;
        assert!(reopened.load(record.binding)?.is_some());
        drop(reopened);
        let mut changed = input()?;
        changed.scope = scope.clone();
        let error = engine
            .start(changed, "fixture-token".into())
            .await
            .err()
            .expect("binding rejected");
        assert!(error.to_string().contains("Retired scope binding"));
        engine.remove(&scope).await?;
        assert!(!root.join(format!("{scope}.bin")).exists());
        assert!(!engine
            .inner
            .retired
            .lock()
            .map_err(|_| anyhow!("lock"))?
            .contains_key(&scope));
        // Removal is intentionally not idempotent for forgotten/unknown locations.
        assert!(engine
            .remove(&scope)
            .await
            .expect_err("A forgotten location cannot claim reset success")
            .to_string()
            .contains("location unknown or forgotten"));
        stream.cancel();
        engine.shutdown();
        Ok(())
    }

    #[tokio::test]
    async fn retired_location_registry_is_bounded_and_stateless_reset_is_explicit() -> Result<()> {
        let engine = Engine::new()?;
        {
            let mut retired = engine.inner.retired.lock().map_err(|_| anyhow!("lock"))?;
            for n in 0..MAX_RETIRED * 2 {
                remember_retired(
                    &mut retired,
                    format!("{n:064x}"),
                    RecoveryLocation {
                        binding: [7; 32],
                        root: None,
                    },
                );
                assert!(retired.len() <= MAX_RETIRED);
            }
        }
        let known = engine
            .inner
            .retired
            .lock()
            .map_err(|_| anyhow!("lock"))?
            .keys()
            .next()
            .cloned()
            .expect("entry");
        engine.remove(&known).await?;
        assert_eq!(
            engine
                .inner
                .retired
                .lock()
                .map_err(|_| anyhow!("lock"))?
                .len(),
            MAX_RETIRED - 1
        );
        let forgotten = (0..MAX_RETIRED * 2)
            .map(|n| format!("{n:064x}"))
            .find(|scope| {
                !engine
                    .inner
                    .retired
                    .lock()
                    .expect("lock")
                    .contains_key(scope)
            })
            .expect("evicted location");
        assert!(engine.remove(&forgotten).await.is_err());
        engine.shutdown();
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn forgotten_recovery_location_never_deletes_or_claims_reset_of_action_ledger(
    ) -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("custom-recovery");
        let engine = Engine::new()?;
        let mut i = input()?;
        i.stateless = false;
        i.cache_dir = Some(root.to_string_lossy().into());
        let mut record;
        {
            let mut retired = engine.inner.retired.lock().map_err(|_| anyhow!("lock"))?;
            for n in 0..MAX_RETIRED {
                remember_retired(
                    &mut retired,
                    format!("{n:064x}"),
                    RecoveryLocation {
                        binding: [7; 32],
                        root: None,
                    },
                );
            }
            // Choose the exact next eviction victim without depending on HashMap's
            // randomized iteration order. Saving a file cannot change that order.
            i.scope = retired.keys().next().cloned().expect("entry");
            record = Record::new(
                i.scope.clone(),
                binding(&i, &agent_url(i.agent_url.as_deref())?),
            );
            record.in_flight = true;
            record.had_actions = true;
            record.pending.insert(
                "action".into(),
                Pending {
                    tool: PendingTool {
                        exec_id: "exec".into(),
                        exec_message_id: 1,
                        tool_call_id: "action".into(),
                        name: "read".into(),
                        input: json!({}),
                    },
                    exposed: true,
                },
            );
            let journal = Journal::open(&root, &i.scope)?;
            journal.save(&record)?;
            drop(journal);
            let location = retired.get_mut(&i.scope).expect("location");
            location.binding = record.binding;
            location.root = Some(root.clone());
            remember_retired(
                &mut retired,
                "f".repeat(64),
                RecoveryLocation {
                    binding: [7; 32],
                    root: None,
                },
            );
            assert!(!retired.contains_key(&i.scope));
        }
        assert!(engine
            .remove(&i.scope)
            .await
            .expect_err("An evicted location must preserve its journal")
            .to_string()
            .contains("reset not performed"));
        let journal = Journal::open(&root, &i.scope)?;
        let preserved = journal.load(record.binding)?.expect("action ledger");
        assert!(preserved.had_actions && preserved.pending["action"].exposed);
        drop(journal);
        // Re-registering the original location is an explicit path to reset even
        // when normal continuation would fail due to missing transcript lineage.
        let stream = engine.start(i.clone(), "fixture-token".into()).await?;
        engine.remove(&i.scope).await?;
        assert!(!root.join(format!("{}.bin", i.scope)).exists());
        stream.cancel();
        engine.shutdown();
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn session_limit_reaps_only_closed_idle_slots_without_removing_journals() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path().canonicalize()?.join("recovery");
        let mut fixture = RpcFixture::new().await?;
        let engine = Engine::new()?;
        let mut i = input()?;
        i.agent_url = Some(fixture.url.clone());
        let expired_scope = format!("{:064x}", 1);
        let journal = Journal::open(&root, &expired_scope)?;
        let mut record = Record::new(expired_scope.clone(), [7; 32]);
        record.in_flight = true;
        record.had_actions = true;
        record.pending.insert(
            "parked".into(),
            Pending {
                tool: PendingTool {
                    exec_id: "exec".into(),
                    exec_message_id: 1,
                    tool_call_id: "parked".into(),
                    name: "read".into(),
                    input: json!({}),
                },
                exposed: true,
            },
        );
        journal.save(&record)?;
        let mut receivers = Vec::new();
        for n in 0..MAX_SESSIONS {
            let scope = format!("{n:064x}");
            let (jobs, rx) = mpsc::channel(1);
            engine
                .inner
                .slots
                .lock()
                .map_err(|_| anyhow!("lock"))?
                .insert(
                    scope,
                    Slot {
                        binding: [7; 32],
                        root: None,
                        journal: if n == 1 { Some(journal.clone()) } else { None },
                        busy: Arc::new(AtomicBool::new(n == 0)),
                        stop: engine.inner.stop.child_token(),
                        jobs,
                    },
                );
            receivers.push(Some(rx));
        }
        // Even a closed busy slot cannot be evicted, nor can any live park.
        drop(receivers[0].take());
        let error = engine
            .start(i.clone(), "fixture-token".into())
            .await
            .err()
            .ok_or_else(|| anyhow!("Expected session limit"))?;
        assert!(error.to_string().contains("session limit"));
        // Simulate the actor receiver closing on PARK_TTL expiration.
        drop(receivers[1].take());
        let next = engine.start(i, "fixture-token".into()).await?;
        {
            let slots = engine.inner.slots.lock().map_err(|_| anyhow!("lock"))?;
            assert_eq!(slots.len(), MAX_SESSIONS);
            assert!(slots.contains_key(&format!("{:064x}", 0)));
            assert!(!slots.contains_key(&expired_scope));
            for n in 2..MAX_SESSIONS {
                assert!(slots.contains_key(&format!("{n:064x}")));
            }
        }
        assert!(root.join(format!("{expired_scope}.bin")).is_file());
        let retained = journal.load(record.binding)?.expect("test fixture value");
        assert!(retained.in_flight && retained.had_actions && retained.pending["parked"].exposed);
        let (request, mut response) = fixture.request().await?;
        let mut body = request.into_body();
        run_request(&mut body).await?;
        successful_response(&mut response)?;
        assert_success(&collect(&next).await?);
        engine.shutdown();
        fixture.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn expired_first_response_401_refreshes_and_actually_reopens_successfully() -> Result<()>
    {
        let mut fixture = RpcFixture::new().await?;
        let engine = Engine::new()?;
        let mut i = input()?;
        i.agent_url = Some(fixture.url.clone());
        i.max_retries = Some(1);
        let stream = engine.start(i, "expired-fixture-token".into()).await?;
        let (request, mut response) = fixture.request().await?;
        assert_eq!(request.uri().path(), RUN_PATH);
        assert_eq!(
            request.headers()[http::header::AUTHORIZATION],
            "Bearer expired-fixture-token"
        );
        let mut body = request.into_body();
        let first_run = run_request(&mut body).await?;
        response.send_response(http::Response::builder().status(401).body(())?, true)?;
        assert_eq!(
            stream.next().await.expect("test fixture value")["type"],
            "response-metadata"
        );
        assert_eq!(
            time::timeout(Duration::from_secs(2), stream.next())
                .await?
                .expect("test fixture value")["type"],
            "native-token-refresh"
        );
        stream
            .set_access_token("fresh-private-fixture-token".into())
            .await?;
        let (request, mut response) = fixture.request().await?;
        assert_eq!(
            request.headers()[http::header::AUTHORIZATION],
            "Bearer fresh-private-fixture-token"
        );
        let mut next_body = request.into_body();
        let reopened = run_request(&mut next_body).await?;
        assert_eq!(first_run.requested_model, reopened.requested_model);
        successful_response(&mut response)?;
        let events = collect(&stream).await?;
        assert_success(&events);
        assert!(!serde_json::to_string(&events)?.contains("fixture-token"));
        assert!(fixture.requests.try_recv().is_err());
        engine.shutdown();
        fixture.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn known_ids_get_recorded_results_and_unknown_recovery_actions_fail_closed() -> Result<()>
    {
        let mut s = session()?;
        s.recovery_fence = true;
        s.context.tools =
            vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})];
        let tool = PendingTool {
            exec_id: "old-exec".into(),
            exec_message_id: 1,
            tool_call_id: "known".into(),
            name: "read".into(),
            input: json!({}),
        };
        s.record.completed.insert(
            "known".into(),
            Completed {
                tool,
                output: json!({"type":"text","value":"RECORDED"}),
            },
        );
        let (rpc, _incoming, mut outgoing) = fake_rpc();
        s.rpc = Some(rpc);
        assert!(matches!(
            s.actions(&tool_message("known"), None).await,
            Ok(Flow::Progress)
        ));
        assert!(outgoing.recv().await.is_some());
        assert!(s.record.pending.is_empty());
        assert!(s.actions(&tool_message("unknown"), None).await.is_err());
        assert!(s.record.pending.is_empty());
        Ok(())
    }
}
