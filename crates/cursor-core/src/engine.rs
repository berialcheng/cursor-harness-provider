//! Session ownership and conservative recovery. The host, never this process,
//! executes tools. An interrupted action turn may replay known result identities,
//! but cannot introduce another unknown host action until TurnEnded is observed.
use std::{
    collections::HashMap,
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
use sha2::{Digest, Sha256};
use tokio::{
    sync::mpsc,
    time::{self, Instant},
};
use tokio_util::sync::CancellationToken;

use crate::{
    journal::{self, Completed, Journal, Pending, Record},
    pb, protocol,
    transport::{self, Client, Connection, Frame},
    types::{PendingTool, ServerAction, StartInput, WireContext},
};

const MAX_SESSIONS: usize = 64;
const PARK_TTL: Duration = Duration::from_secs(60 * 60);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(30);
const RUN_PATH: &str = "/agent.v1.AgentService/Run";

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}
struct Inner {
    client: Client,
    stop: CancellationToken,
    slots: Mutex<HashMap<String, Slot>>,
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
    events: tokio::sync::Mutex<mpsc::Receiver<Value>>,
    control: Arc<Control>,
    refresh: mpsc::Sender<String>,
}
impl RunningStream {
    pub async fn next(&self) -> Option<Value> {
        self.events.lock().await.recv().await
    }
    pub fn cancel(&self) {
        if !self.control.finished.load(Ordering::Acquire) {
            self.control.cancel.cancel();
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
                scope == &input.scope || !slot.jobs.is_closed() || slot.busy.load(Ordering::Acquire)
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
            );
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
    pub async fn models(&self, access_token: String, url: Option<String>) -> Result<Value> {
        validate_token(&access_token)?;
        ensure!(
            !self.inner.stop.is_cancelled(),
            "Cursor engine is shut down"
        );
        let route = agent_url(url.as_deref())?;
        let (path, request) = protocol::model_list_request();
        let bytes = tokio::select! {
            biased;
            _ = self.inner.stop.cancelled() => bail!("Cursor engine is shut down"),
            result = transport::unary(&self.inner.client, &route, &path, &access_token, request, 30_000) =>
                result.map_err(|_| anyhow!("Cursor model discovery failed; check authentication and HTTP/2 connectivity"))?,
        };
        protocol::decode_model_list(&bytes).map_err(|_| anyhow!("Invalid Cursor model list"))
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
        let slot = self
            .inner
            .slots
            .lock()
            .map_err(|_| anyhow!("Session registry lock failed"))?
            .remove(scope);
        if let Some(slot) = slot {
            slot.stop.cancel();
            if let Some(journal) = &slot.journal {
                journal.remove()?;
            }
            time::timeout(Duration::from_secs(5), slot.jobs.closed())
                .await
                .map_err(|_| anyhow!("Scope cancellation is pending"))?;
        } else {
            Journal::open(&cache_root(None)?, scope)?.remove()?;
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
}
impl Session {
    fn new(
        mut record: Record,
        journal: Option<Journal>,
        route: String,
        client: Client,
        stop: CancellationToken,
        stateless: bool,
    ) -> Self {
        let context = WireContext {
            blobs: std::mem::take(&mut record.blobs),
            ..Default::default()
        };
        Self {
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
        }
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
        if result.is_err() {
            self.blocked = true;
        }
        result
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
        self.record.conversation = uuid::Uuid::new_v4().to_string();
        self.context = WireContext::default();
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
                            if self.actions(&bytes, None).await.is_err() { self.blocked = true; self.stop_rpc(); }
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
    // Validation errors leave a previously parked RPC intact and do not consume
    // pending calls. Every recorded result is committed before any wire send.
    fn reconcile(&mut self, job: &Job) -> Result<Vec<(PendingTool, Value)>> {
        ensure!(
            !self.blocked,
            "Session recovery is blocked; explicitly remove this scope"
        );
        for (id, done) in &self.record.completed {
            if let Some(value) = job.results.get(id) {
                ensure!(value == &done.output, "A recorded host result changed");
            }
        }
        for (id, pending) in &self.record.pending {
            ensure!(
                !pending.exposed || job.results.contains_key(id),
                "Matching results for every pending tool-call ID are required"
            );
        }
        if self.rpc.is_some() {
            let tools = if job.input.tool_choice == "none" {
                &[][..]
            } else {
                &job.input.tools[..]
            };
            ensure!(
                self.context.tools == tools,
                "Host tool registry changed while an RPC was parked"
            );
        }
        if self.rpc.is_none()
            && !self.record.in_flight
            && self.record.checkpoint.is_empty()
            && !job.results.is_empty()
        {
            ensure!(
                job.input.prompt.last().and_then(|m| m.get("role")).and_then(Value::as_str) == Some("user"),
                "Host-action continuation requires an existing RPC or checkpoint; stateless restart cannot recover it"
            );
        }
        // Authoritative host history can include completed actions predating this
        // process. Keep their exact IDs/results too, but never invent exec IDs to
        // send proactively: a re-issued request supplies its own exec envelope.
        let mut imported = false;
        for part in job
            .input
            .prompt
            .iter()
            .filter(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
            .filter_map(|m| m.get("content").and_then(Value::as_array))
            .flatten()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("tool-call"))
        {
            let Some(id) = part.get("toolCallId").and_then(Value::as_str) else {
                continue;
            };
            let Some(output) = job.results.get(id) else {
                continue;
            };
            if self.record.pending.contains_key(id) || self.record.completed.contains_key(id) {
                continue;
            }
            let name = part
                .get("toolName")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("Missing historical tool name"))?;
            let input = part
                .get("input")
                .filter(|v| v.is_object())
                .ok_or_else(|| anyhow!("Invalid historical tool input"))?;
            ensure!(
                part.get("providerExecuted").and_then(Value::as_bool) != Some(true),
                "Provider-executed actions cannot be replayed as host tools"
            );
            let tool = PendingTool {
                exec_id: "host-history".into(),
                exec_message_id: 0,
                tool_call_id: id.into(),
                name: name.into(),
                input: input.clone(),
            };
            self.record.completed.insert(
                id.into(),
                Completed {
                    tool,
                    output: output.clone(),
                },
            );
            imported = true;
        }
        let ids: Vec<_> = self
            .record
            .pending
            .keys()
            .filter(|id| job.results.contains_key(*id))
            .cloned()
            .collect();
        let mut replies = Vec::new();
        for id in ids {
            let pending = self
                .record
                .pending
                .get(&id)
                .ok_or_else(|| anyhow!("Missing pending tool"))?;
            ensure!(
                pending.exposed,
                "Host supplied a result for a tool not yet exposed"
            );
            let value = job
                .results
                .get(&id)
                .ok_or_else(|| anyhow!("Missing host result"))?
                .clone();
            protocol::tool_result(&pending.tool, &value)
                .map_err(|_| anyhow!("Unsupported host tool output"))?;
            replies.push((pending.tool.clone(), value));
        }
        for (tool, output) in &replies {
            self.record.pending.remove(&tool.tool_call_id);
            self.record.completed.insert(
                tool.tool_call_id.clone(),
                Completed {
                    tool: tool.clone(),
                    output: output.clone(),
                },
            );
        }
        if imported || !replies.is_empty() {
            self.persist()?;
        }
        Ok(replies)
    }
    async fn open(&mut self, job: &Job) -> Result<()> {
        if self.record.in_flight {
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
        let initial = protocol::build_request(
            &job.input,
            &self.record.conversation,
            checkpoint,
            &mut self.context,
        )
        .map_err(|_| {
            anyhow!(
                "Cannot build Cursor request safely (prompt, tools, checkpoint, or blob bounds)"
            )
        })?;
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
        if let Some(rpc) = &self.rpc {
            watch_cancel(
                job.output.control.clone(),
                rpc.cancel.clone(),
                self.stop.clone(),
            );
        }
        let replies = self.reconcile(job).map_err(|_| {
            "Host results do not match pending calls, a result changed, or recovery state cannot be committed"
        })?;
        job.output.accepted = true;
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
            if self.rpc.is_none() && self.open(job).await.is_err() {
                self.stop_rpc();
                return Err("Cannot safely open or restore Cursor turn; an interrupted turn requires a valid checkpoint. No unknown host action was replayed");
            }
            if send_replies {
                send_replies = false;
                for (tool, result) in &replies {
                    let raw = protocol::tool_result(tool, result)
                        .map_err(|_| "Unsupported host tool output")?;
                    if self.send(raw, Some(&job.output)).await.is_err() {
                        self.stop_rpc();
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
        let mut deadline = Instant::now() + idle;
        loop {
            let frame = tokio::select! {
                biased;
                _ = self.stop.cancelled() => return Attempt::Fatal("Cursor engine stopped"),
                _ = output.control.cancel.cancelled() => return Attempt::Fatal("Cursor request aborted"),
                _ = time::sleep_until(deadline) => return Attempt::Lost(false),
                frame = async { match self.rpc.as_mut() { Some(rpc) => rpc.incoming.recv().await, None => None } } => frame,
            };
            match frame {
                Some(Ok(Frame::Message(bytes))) => match self.actions(&bytes, Some(output)).await {
                    Ok(Flow::Done) => return Attempt::Done,
                    Ok(Flow::Progress) => deadline = Instant::now() + idle,
                    Ok(Flow::Liveness) => {}
                    Err(message) => return Attempt::Fatal(message),
                },
                Some(Ok(Frame::End(value))) => return Attempt::Lost(auth_end(&value)),
                Some(Err(error)) => return Attempt::Lost(auth_error(&error.to_string())),
                None => return Attempt::Lost(false),
            }
        }
    }
    async fn send(&self, raw: Vec<u8>, output: Option<&Output>) -> Result<()> {
        let rpc = self
            .rpc
            .as_ref()
            .ok_or_else(|| anyhow!("Cursor RPC is unavailable"))?;
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => bail!("Cursor engine stopped"),
            _ = async { match output { Some(o) => o.control.cancel.cancelled().await, None => std::future::pending().await } } => bail!("Cursor request aborted"),
            result = time::timeout(Duration::from_secs(5), rpc.outgoing.send(raw)) => result?.map_err(|_| anyhow!("Cursor upload stopped")),
        }
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
        for tool in &tools {
            if let Some(p) = self.record.pending.get_mut(&tool.tool_call_id) {
                p.exposed = true;
            }
        }
        self.record.had_actions = true;
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
        mut output: Option<&mut Output>,
    ) -> std::result::Result<Flow, &'static str> {
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
                    o.delta("text", text).await?;
                }
                ServerAction::Reasoning(text) => {
                    let o = output
                        .as_deref_mut()
                        .ok_or("Unexpected reasoning while parked on host actions; refusing silent output loss")?;
                    o.delta("reasoning", text).await?;
                }
                ServerAction::Checkpoint(bytes) => {
                    self.record.checkpoint = bytes;
                    self.persist()
                        .map_err(|_| "Cannot persist checkpoint; recovery stopped")?;
                }
                ServerAction::Reply(bytes) => {
                    // KV writes mutate the blob store. Acknowledging only after
                    // commit prevents checkpoints with missing blobs after restart.
                    self.persist()
                        .map_err(|_| "Cannot commit Cursor blob/reply state")?;
                    self.send(bytes, output.as_deref())
                        .await
                        .map_err(|_| "Cursor reply upload failed")?;
                }
                ServerAction::RejectedLocal => {
                    self.rejects += 1;
                    if self.rejects >= 8 {
                        return Err("Cursor repeatedly requested forbidden native operations (limit 8); no local tool was executed");
                    }
                }
                ServerAction::Tool(tool) => {
                    if let Some(done) = self.record.completed.get(&tool.tool_call_id) {
                        if !same_action(&done.tool, &tool) {
                            return Err(
                                "Cursor reused a completed tool ID with different arguments",
                            );
                        }
                        let reply = protocol::tool_result(&tool, &done.output)
                            .map_err(|_| "Recorded host result cannot be encoded")?;
                        self.send(reply, output.as_deref())
                            .await
                            .map_err(|_| "Recorded host result upload failed")?;
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
                    self.record.in_flight = false;
                    self.record.had_actions = false;
                    self.persist().map_err(|_| "Cannot commit completed turn")?;
                    self.stop_rpc();
                    if let Some(o) = output.as_deref_mut() {
                        o.finish(false).await?;
                    }
                    if self.stateless {
                        self.record = Record::new(self.record.scope.clone(), self.record.binding);
                        self.context = WireContext::default();
                    }
                    return Ok(Flow::Done);
                }
            }
        }
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

struct Output {
    tx: mpsc::Sender<Value>,
    control: Arc<Control>,
    stop: CancellationToken,
    block: Option<(&'static str, String)>,
    sequence: u64,
    exposed: bool,
    accepted: bool,
}
impl Output {
    async fn emit(&self, value: Value) -> std::result::Result<(), &'static str> {
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
            let id = self.sequence.to_string();
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
            self.tx.send(json!({"type":"error","error":message})),
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
    Ok(())
}
fn binding(input: &StartInput, route: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    for s in [&input.scope, &input.model_id, &input.workspace, route] {
        h.update((s.len() as u64).to_le_bytes());
        h.update(s.as_bytes());
    }
    h.update([u8::from(input.stateless)]);
    h.finalize().into()
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
    fn fake_rpc() -> (
        Connection,
        mpsc::Sender<Result<Frame>>,
        mpsc::Receiver<Vec<u8>>,
    ) {
        let (incoming, rx) = mpsc::channel(32);
        let (tx, outgoing) = mpsc::channel(32);
        (
            Connection {
                incoming: rx,
                outgoing: tx,
                cancel: CancellationToken::new(),
            },
            incoming,
            outgoing,
        )
    }
    fn session() -> Result<Session> {
        let i = input()?;
        Ok(Session::new(
            Record::new(i.scope.clone(), binding(&i, "http://127.0.0.1:9")),
            None,
            "http://127.0.0.1:9".into(),
            transport::client()?,
            CancellationToken::new(),
            false,
        ))
    }
    fn server(message: pb::agent_server_message::Message) -> Frame {
        Frame::Message(
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
                stop,
                driver,
            })
        }
        async fn request(&mut self) -> Result<RpcRequest> {
            time::timeout(Duration::from_secs(2), self.requests.recv())
                .await?
                .ok_or_else(|| anyhow!("Expected an actual reopened RPC"))
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
                Frame::Message(raw) => (0, raw),
                Frame::End(value) => (2, serde_json::to_vec(&value)?),
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
                Frame::End(json!({})),
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
            .send(Ok(Frame::Message(tool_message("call"))))
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
        incoming.send(Ok(Frame::End(json!({})))).await?;
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
            .send(Ok(Frame::End(
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
        assert!(s.reconcile(&j).is_err());
        i.prompt
            .push(json!({"role":"user","content":[{"type":"text","text":"new user turn"}]}));
        let (j, _stream) = job(i, Arc::new(AtomicBool::new(true)), s.stop.clone())?;
        s.reconcile(&j)?;
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
                    frames.push(Frame::End(json!({})));
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
            frames.push(Frame::Message(tool_message("call")));
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
                send_frames(&mut send, vec![Frame::Message(tool_message("call"))], false)?;
                // A known ID replays its recorded result, never another host call.
                assert!(
                    matches!(client_message(&mut body).await?.message, Some(pb::agent_client_message::Message::ExecClientMessage(m)) if m.id == 7 && m.exec_id == "exec")
                );
                send_frames(
                    &mut send,
                    vec![Frame::Message(tool_message("unknown"))],
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
