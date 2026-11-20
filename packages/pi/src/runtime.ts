import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRustEngine, nativeVersion, type RustEngine, type RustStream } from "@cursor-harness-provider/native";
import { withDeadline } from "@cursor-harness-provider/native/lifecycle";
import type { Api, Model, SimpleStreamOptions, TranscriptContext, AssistantMessageEventStream, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CursorAuth, type ResolveAuth } from "./auth/index.js";
import { AGENT_URL, HOST_NAMESPACE } from "./constants.js";
import { CursorCatalog, type CursorRoute, type ModelParameter } from "./models.js";
import { PiEventWriter } from "./events.js";
import { abortable, accountPartition, isRecord, safeError } from "./security.js";
import { toNativeTranscript, validateTranscript, type NativeTranscript } from "./transcript.js";
import type { CompatAccess } from "./compat.js";

export interface SessionIdentity { sessionId: string; workspace: string }
export interface RuntimeDependencies {
  createEngine?: () => RustEngine;
  version?: () => string;
  auth?: CursorAuth;
  /** Live Pi registry resolution, never a raw OAuth refresh/rotation callback. */
  resolveAuth?: ResolveAuth;
  env?: () => NodeJS.ProcessEnv;
}
interface NativeRequest extends NativeTranscript {
  scope: string; modelId: string; workspace: string; toolChoice: "auto" | "none";
  modelParameters?: ModelParameter[]; maxMode?: boolean;
  stateless: boolean; cacheDir: string; agentUrl: string;
  idleTimeoutMs?: number; connectTimeoutMs?: number; maxRetries?: number;
}
type Phase = "idle" | "auth" | "preparing" | "start" | "streaming" | "awaiting-tools" | "error" | "aborted" | "fenced";
interface RequestLife { controller: AbortController; phase: Phase; done: Promise<void>; finish(): void; scope?: string; resetIdentities?: Set<string> }
interface ScopeLife {
  scope: string; modelId: string; kind: string; identity: string; state: Phase; requests: Set<RequestLife>;
  pendingStart: boolean; hasStarted: boolean; mayHaveActions: boolean; fenced: boolean; resetting?: boolean; maintenance?: Promise<unknown>; removal?: Promise<void>;
}
interface RoutePin { controlIdentity: string; route: CursorRoute; scope: string; prefix: string; assistant: string; wirePrefix: string; wireLength: number }
// Context and tools may evolve at a reconciled boundary; executable history may not.
const actionHistory = (transcript: NativeTranscript) => transcript.prompt.filter(m => m.role === "assistant" || m.role === "tool");
const scopeCapacity = 128;
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const assistantIdentity = (message: unknown): string => {
  if (!isRecord(message)) return "";
  return fingerprint([message.api, message.provider, message.model, message.timestamp, message.responseId, message.stopReason, message.content]);
};
function boundedTimeout(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum: number): number {
  const value = duration(env[key], key);
  return value === undefined ? fallback : Math.max(1, Math.min(value, maximum));
}
const protectedKeys = ["scope", "modelId", "modelParameters", "maxMode", "workspace", "stateless", "cacheDir", "agentUrl", "idleTimeoutMs", "connectTimeoutMs", "maxRetries"] as const;

function duration(value: unknown, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > 3600000) throw new Error(`Invalid ${name}`);
  return number;
}
// Pi sends its disabled HTTP idle timeout (0/"disabled") as setTimeout's maximum. Native stream
// idleness is bounded at one hour, so disabled or longer host values use that maximum window.
function hostIdleTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid idle timeout");
  return value === 0 ? 3600000 : Math.min(value, 3600000);
}
/** Point native capacity/expiry failures at the explicit Pi operator commands. */
function operatorHint(error: unknown): unknown {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const hint = /^cache_(?:quota|entry_quota)_exceeded:/.test(message)
    ? " Pi: /cursor.cache --select inspects the root; /cursor.reset --select discards a known scope."
    : message.startsWith("Recovery journal is expired") ? " Pi: /cursor.reset --select discards this conversation's recovery state; no tool is undone." : "";
  return hint ? new Error(message + hint) : error;
}
function endpoint(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash) throw new Error("Cursor endpoint must be HTTPS (or loopback HTTP), without credentials/query/hash");
  return url.href.replace(/\/$/, "");
}
/** Returns the normalized copy with its exact JSON, which is also the native start request. */
function requestAfterHook(original: NativeRequest, replacement: unknown): { request: NativeRequest; json: string } {
  const json = JSON.stringify(replacement);
  const candidate: unknown = JSON.parse(json);
  if (!isRecord(candidate)) throw new Error("Cursor payload hook must return a normalized request object");
  const allowed = new Set<string>([...protectedKeys, "prompt", "tools", "toolChoice"]);
  if (Object.keys(candidate).some(key => !allowed.has(key))) throw new Error("Cursor payload hook returned an unsupported field (auth and model routing are immutable)");
  for (const key of protectedKeys) if (JSON.stringify(candidate[key]) !== JSON.stringify(original[key])) throw new Error(`Cursor payload hook cannot change ${key}`);
  if (candidate.toolChoice !== "auto" && candidate.toolChoice !== "none") throw new Error("Cursor supports auto/none tool choice only");
  validateTranscript(candidate);
  return { request: candidate as unknown as NativeRequest, json };
}

/** One lazy engine per extension session. Constructor/factory does no I/O, auth lookup, or scheduling. */
export class PiRustRuntime {
  readonly auth: CursorAuth;
  private engine: RustEngine | undefined;
  private session: SessionIdentity | undefined;
  private closed = false;
  private controllers = new Set<AbortController>();
  private catalogs = new Map<string, CursorCatalog>();
  private bootstrap = new CursorCatalog();
  private activeAccount: string | undefined;
  private activeEndpoint: string | undefined;
  private lastError: string | undefined;
  private requests = new Set<RequestLife>();
  private scopes = new Map<string, ScopeLife>();
  private pins = new Map<string, RoutePin>();
  private leases = new Map<string, RequestLife>();
  private continuesPin(pin: RoutePin, context: TranscriptContext): boolean {
    const messages = context.messages.filter(m => m.role !== "system");
    const index = messages.findLastIndex(m => m.role === "assistant");
    if (index < 0 || assistantIdentity(messages[index]) !== pin.assistant) return false;
    const assistant = messages[index];
    if (assistant?.role !== "assistant" || assistant.provider !== "cursor" || assistant.api !== "cursor-native-rust" || assistant.stopReason !== "toolUse") return false;
    const calls = assistant.content.filter(p => p.type === "toolCall");
    const results = messages.slice(index + 1, index + 1 + calls.length);
    if (!calls.length || results.length !== calls.length || calls.some(call => call.argumentsError || results.filter(r => r.role === "toolResult" && r.toolCallId === call.id && r.toolName === call.name).length !== 1)) return false;
    if (messages.slice(index + 1 + calls.length).some(m => m.role !== "user")) return false;
    const prefix = toNativeTranscript({ ...context, messages: messages.slice(0, index + 1) });
    return fingerprint(prefix.prompt.filter(m => m.role !== "system")) === pin.prefix;
  }
  ownsSession(sessionId: string, workspace: string): boolean {
    return !this.closed && isAbsolute(workspace) && this.session?.sessionId === sessionId && this.session.workspace === resolve(workspace);
  }
  recoveryScopes(): Array<{ scope: string; modelId: string; kind: string; state: string; activeRequests: number; pendingStart: boolean; mayHaveActions: boolean }> {
    return [...this.scopes.values()].map(s => ({ scope: s.scope, modelId: s.modelId, kind: s.kind,
      state: s.fenced ? "fenced" : s.state, activeRequests: s.requests.size, pendingStart: s.pendingStart, mayHaveActions: s.mayHaveActions }));
  }
  private knownScope(scope: string): ScopeLife {
    if (this.closed) throw new Error("Cursor session is shut down");
    const known = this.scopes.get(scope);
    if (!known) throw new Error("Cursor recovery scope is unknown to this runtime");
    return known;
  }
  async resetScope(scope: string, signal?: AbortSignal): Promise<void> {
    const known = this.knownScope(scope);
    if (known.resetting || known.maintenance || known.removal) throw new Error("Cursor scope recovery is already active; no reset performed");
    const { controller, release } = this.operation(signal);
    try {
      controller.signal.throwIfAborted();
      known.fenced = true; known.resetting = true;
      for (const request of known.requests) request.controller.abort();
      // Auth may still be resolving a scope. Do not abort unrelated accounts/children,
      // but do reject a pre-reset request if it later resolves to this exact identity.
      for (const request of this.requests) if (!request.scope) (request.resetIdentities ??= new Set()).add(known.identity);
      await withDeadline(async resetSignal => {
        await Promise.all([...known.requests].map(request => request.done));
        resetSignal.throwIfAborted(); controller.signal.throwIfAborted();
        if (this.closed || this.scopes.get(scope) !== known) throw new Error("Cursor recovery lifecycle changed");
        if (this.engine) {
          const pending = this.engine.remove(scope); known.removal = pending;
          try { await pending; } finally { if (known.removal === pending) known.removal = undefined; }
        }
      }, { signal: controller.signal, timeoutMs: boundedTimeout(this.environment(), "PI_CURSOR_RESET_TIMEOUT_MS", 5000, 5000),
        code: "CURSOR_RESET_TIMEOUT", message: "Cursor reset timed out; scope remains fenced, no reset confirmed" });
      controller.signal.throwIfAborted();
      if (this.closed) throw new Error("Cursor session is shut down");
      for (const [key, pin] of this.pins) if (pin.scope === scope) this.pins.delete(key);
      this.scopes.delete(scope);
    } finally { known.resetting = false; release(); }
  }
  async maintainCache(scope: string, apply: boolean, signal?: AbortSignal): Promise<unknown> {
    const known = this.knownScope(scope);
    if (known.fenced || known.requests.size || known.pendingStart) throw new Error("Cursor cache maintenance requires a quiescent unfenced scope");
    const engine = this.engine as (RustEngine & { maintainCache?(scope: string, apply?: boolean): Promise<string> }) | undefined;
    if (!engine?.maintainCache) throw new Error("Cursor native cache maintenance is unavailable; no filesystem fallback");
    const { controller, release } = this.operation(signal);
    try {
      controller.signal.throwIfAborted();
      known.fenced = true;
      const raw = await withDeadline(() => {
        const pending = engine.maintainCache!(scope, apply); known.maintenance = pending;
        void pending.finally(() => { if (known.maintenance === pending) known.maintenance = undefined; }).catch(() => {});
        return pending;
      }, { signal: controller.signal,
        timeoutMs: boundedTimeout(this.environment(), "PI_CURSOR_RESET_TIMEOUT_MS", 5000, 5000),
        code: "CURSOR_CACHE_TIMEOUT", message: "Cursor cache maintenance timed out; scope remains fenced" });
      controller.signal.throwIfAborted();
      if (this.closed || this.scopes.get(scope) !== known) throw new Error("Cursor recovery lifecycle changed");
      const result: unknown = JSON.parse(raw); known.fenced = false; return result;
    } finally { release(); }
  }
  private admit(scope: string, modelId: string, kind: string, identity: string, life: RequestLife): ScopeLife {
    let known = this.scopes.get(scope);
    if (known?.fenced || known?.requests.size) throw new Error("Cursor scope is fenced or already active");
    if (!known) {
      if (this.scopes.size >= scopeCapacity) {
        const safe = [...this.scopes.values()].find(s => !s.fenced && !s.requests.size && !s.pendingStart && !s.mayHaveActions && (!s.hasStarted || s.state === "idle"));
        if (!safe) throw new Error("Cursor recovery scope capacity reached; reset a known scope");
        this.scopes.delete(safe.scope);
      }
      known = { scope, modelId, kind, identity, state: "preparing", requests: new Set(), pendingStart: false, hasStarted: false, mayHaveActions: false, fenced: false };
      this.scopes.set(scope, known);
    }
    known.requests.add(life); life.scope = scope; return known;
  }
  constructor(private deps: RuntimeDependencies = {}) { this.auth = deps.auth ?? new CursorAuth(); }
  get isClosed(): boolean { return this.closed; }
  setSession(identity: SessionIdentity): void {
    if (this.closed) throw new Error("Cursor session is shut down");
    if (!isAbsolute(identity.workspace)) throw new Error("Pi workspace must be an absolute path");
    if (this.session && (this.session.sessionId !== identity.sessionId || this.session.workspace !== identity.workspace)) throw new Error("Use a new Cursor runtime for a replaced Pi session");
    this.session = { ...identity, workspace: resolve(identity.workspace) };
  }
  private getEngine(): RustEngine {
    if (this.closed) throw new Error("Cursor session is shut down");
    return this.engine ??= (this.deps.createEngine ?? createRustEngine)();
  }
  private environment(overrides?: Record<string, string>): NodeJS.ProcessEnv { return { ...(this.deps.env?.() ?? process.env), ...overrides }; }
  private catalogKey(account: string, url: string): string { return JSON.stringify([account, url]); }
  private catalog(account: string, url: string): CursorCatalog {
    const key = this.catalogKey(account, url);
    let catalog = this.catalogs.get(key);
    if (!catalog) { catalog = new CursorCatalog(); catalog.ensureAccount(account); this.catalogs.set(key, catalog); }
    this.activeAccount = key; this.activeEndpoint = url;
    return catalog;
  }
  private installCatalog(catalog: CursorCatalog, account: string, url: string): void {
    const key = this.catalogKey(account, url);
    this.catalogs.set(key, catalog); this.activeAccount = key; this.activeEndpoint = url;
  }
  /** Pi supplies the immutable persisted catalog and owns all disk access/publication generations. */
  async refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
    if (this.closed) throw new Error("Cursor session is shut down");
    const rawEnv = context.credential?.env;
    const overrides = isRecord(rawEnv) ? Object.fromEntries(Object.entries(rawEnv).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : undefined;
    const env = this.environment(overrides);
    const token = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key ?? env.CURSOR_ACCESS_TOKEN;
    const url = endpoint(env.PI_CURSOR_AGENT_URL ?? env.CURSOR_AGENT_URL ?? context.baseUrl ?? AGENT_URL);
    context.signal.throwIfAborted();
    if (!context.allowNetwork) {
      // Cache restoration must not scrape OS credentials or start the native binding.
      if (!token?.trim()) return this.bootstrap.definitions();
      const account = accountPartition(token.trim()), restored = new CursorCatalog(), key = this.catalogKey(account, url);
      restored.ensureAccount(account);
      const catalog = restored.restore(context.stored, account, url) ? restored : this.catalogs.get(key) ?? restored;
      const published = await context.publish({ update: () => { if (!this.closed && !context.signal.aborted) this.installCatalog(catalog, account, url); } });
      context.signal.throwIfAborted();
      if (this.closed) throw new Error("Cursor session is shut down");
      return (published ? catalog : this.catalogs.get(key) ?? this.bootstrap).definitions(url);
    }
    const { controller, release } = this.operation(context.signal);
    let secret = "";
    try {
      const bound = await this.auth.bind(token, env, controller.signal); secret = bound.accessToken;
      const raw = await abortable(this.getEngine().listModels(secret, url), controller.signal);
      controller.signal.throwIfAborted();
      const catalog = new CursorCatalog(); catalog.apply(raw, bound.account);
      const published = await context.publish({ persist: { models: catalog.persistedModels(url), checkedAt: Date.now() },
        update: () => { if (!this.closed && !controller.signal.aborted) this.installCatalog(catalog, bound.account, url); } });
      controller.signal.throwIfAborted();
      return (published ? catalog : this.catalogs.get(this.catalogKey(bound.account, url)) ?? this.bootstrap).definitions(url);
    } catch (error) { throw new Error(safeError(error, [secret])); } finally { release(); }
  }
  definitions(): ProviderModelConfig[] { return (this.activeAccount ? this.catalogs.get(this.activeAccount)! : this.bootstrap).definitions(this.activeEndpoint); }
  private operation(signal?: AbortSignal): { controller: AbortController; release(): void } {
    const controller = new AbortController();
    const relay = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", relay, { once: true });
    if (signal?.aborted || this.closed) relay();
    this.controllers.add(controller);
    return { controller, release: () => { signal?.removeEventListener("abort", relay); this.controllers.delete(controller); } };
  }
  async discover(apiKey: string | undefined, signal?: AbortSignal, envOverrides?: Record<string, string>, url?: string): Promise<ProviderModelConfig[]> {
    const { controller, release } = this.operation(signal);
    let token = "";
    try {
      const env = this.environment(envOverrides);
      const bound = await this.auth.bind(apiKey, env, controller.signal); token = bound.accessToken;
      const agentUrl = endpoint(env.PI_CURSOR_AGENT_URL ?? env.CURSOR_AGENT_URL ?? url ?? AGENT_URL);
      const raw = await abortable(this.getEngine().listModels(token, agentUrl), controller.signal);
      controller.signal.throwIfAborted();
      const catalog = this.catalog(bound.account, agentUrl); catalog.apply(raw, bound.account);
      return catalog.definitions(agentUrl);
    } catch (error) { throw new Error(safeError(error, [token])); } finally { release(); }
  }
  async usage(apiKey: string | undefined, signal?: AbortSignal, envOverrides?: Record<string, string>): Promise<unknown> {
    const { controller, release } = this.operation(signal); let token = "";
    try {
      const engine = this.getEngine() as RustEngine & { getUsage?: (token: string) => Promise<string> };
      if (typeof engine.getUsage !== "function") throw new Error("Cursor usage unavailable: this Rust binding does not expose getUsage; no JS fallback and no quota estimate");
      const binding = await this.auth.bind(apiKey, this.environment(envOverrides), controller.signal); token = binding.accessToken;
      const raw = await abortable(engine.getUsage(token), controller.signal);
      return JSON.parse(raw) as unknown;
    } catch (error) { throw new Error(safeError(error, [token])); } finally { release(); }
  }
  doctor(): string {
    let version: string;
    try { version = (this.deps.version ?? nativeVersion)(); } catch (error) { version = safeError(error); }
    return ["Cursor Native (Pi)", "provider=cursor api=cursor-native-rust", `nativeVersion=${version}`,
      `engine=${this.engine ? "session-owned" : "not started (lazy)"}`, `activeRequests=${this.controllers.size}`,
      `phases=${JSON.stringify(Object.fromEntries(["idle", "auth", "preparing", "start", "streaming", "awaiting-tools", "error", "aborted", "fenced"].map(phase => [phase, [...this.requests].filter(r => r.phase === phase).length])))}`,
      `capacity=known-scopes ${this.scopes.size}/${scopeCapacity}; pinned-routes ${this.pins.size}`,
      `recovery=${JSON.stringify(this.recoveryScopes().map(({ state, activeRequests, pendingStart, mayHaveActions }) => ({ state, activeRequests, pendingStart, mayHaveActions })))}`,
      `resources=${this.resourceSummary()}`, ...this.cacheCapacity(), `models=${this.definitions().length}`, "tools=Pi permission gate only; native local actions forbidden",
      "httpHeaders=not exposed by Rust; onResponse unavailable", "catalog=direct IDs and advertised parameter combinations only; Max Mode is separate from reasoning:max",
      "images=advertised inline attachments/tool results only; no path/clipboard/URL reads",
      "sessions=parent/child checkpoints isolated; cacheRetention:none is one-shot; catalog restored through Pi",
      "tokens/cache/billing=unreported unless Rust explicitly reports them; zero is not verified quota",
      `lastError=${this.lastError ?? "none"}`].join("\n");
  }
  private resourceSummary(): string {
    const engine = this.engine as (RustEngine & { resourceStats?(): string }) | undefined;
    if (!engine?.resourceStats) return "unavailable (no engine start for diagnostics)";
    try {
      const raw: unknown = JSON.parse(engine.resourceStats());
      if (!isRecord(raw)) return "unavailable";
      // Only numeric shape/capacity counters: never echo arbitrary native strings or paths.
      const allowed = new Set(["actors", "bytes", "limitBytes", "trackedBytes", "peakBytes", "exhaustions", "cacheLimitBytes", "cacheLimitEntries", "cacheTemporaryLimitBytes",
        "cacheScanLimitEntries", "cacheCommittedBytes", "cacheRecords", "cacheDirectoryEntries"]);
      return JSON.stringify({ ...Object.fromEntries(Object.entries(raw).filter(([key, value]) => allowed.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0)), rssBounded: false });
    } catch { return "unavailable"; }
  }
  /** Root usage seen at the latest native commit; maintenance stays explicit and consented. */
  private cacheCapacity(): string[] {
    const engine = this.engine as (RustEngine & { resourceStats?(): string }) | undefined;
    let raw: unknown;
    try { raw = engine?.resourceStats ? JSON.parse(engine.resourceStats()) : undefined; } catch { return []; }
    if (!isRecord(raw)) return [];
    const usage = ([["cacheCommittedBytes", "cacheLimitBytes"], ["cacheRecords", "cacheLimitEntries"], ["cacheDirectoryEntries", "cacheScanLimitEntries"]] as const)
      .flatMap(([used, limit]) => typeof raw[used] === "number" && typeof raw[limit] === "number" && (raw[limit] as number) > 0
        ? [{ name: used, ratio: (raw[used] as number) / (raw[limit] as number) }] : []);
    if (!usage.length) return [];
    const line = `cacheRoot=${usage.map(u => `${u.name.replace(/^cache/, "")} ${Math.round(u.ratio * 100)}%`).join(", ")} (latest commit)`;
    return usage.some(u => u.ratio >= 0.8)
      ? [line, "cacheWarning=root near capacity; inspect with /cursor.cache --select (apply compacts expired payloads; tombstones and active records remain)"] : [line];
  }
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    const engine = this.engine; this.engine = undefined;
    try { engine?.shutdown(); } finally { this.auth.clear(); this.catalogs.clear(); this.pins.clear(); this.scopes.clear(); this.activeAccount = undefined; this.activeEndpoint = undefined; }
  }
  readonly streamSimple = (model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream => this.stream(model, context, options);
  /** Stable compat IDs continue tools only within this owner lifecycle. No ID means one-shot, with no tool continuation. */
  streamCompat(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions, owner: string,
    resolveAuth: (signal: AbortSignal) => Promise<CompatAccess>): AssistantMessageEventStream {
    return this.stream(model, context, options, { owner, resolveAuth });
  }
  private stream(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions,
    compat?: { owner: string; resolveAuth: (signal: AbortSignal) => Promise<CompatAccess> }): AssistantMessageEventStream {
    const writer = new PiEventWriter(model);
    const { controller, release } = this.operation(options.signal);
    const signal = controller.signal;
    let native: RustStream | undefined, engine: RustEngine | undefined, scope: string | undefined, stateless = true;
    let removal: Promise<void> | undefined;
    let safeCompatCleanup = false;
    let finishLife!: () => void;
    const life: RequestLife = { controller, phase: "auth", done: new Promise<void>(done => { finishLife = done; }), finish: () => finishLife() };
    this.requests.add(life);
    let known: ScopeLife | undefined, pinKey: string | undefined, priorState: Phase | undefined;
    let pendingStart: Promise<RustStream> | undefined, startSettled = false;
    let routing: CursorRoute | undefined;
    const phase = (value: Phase) => { life.phase = value; if (known) known.state = value; };
    const secrets: string[] = [];
    const remove = (lateHandle = false): Promise<void> => {
      // Failed/aborted compat operations may have exposed progress. Never erase their fence.
      if (!engine || !scope || this.leases.get(scope) !== life || !stateless || (compat && !safeCompatCleanup) || (!native && !lateHandle)) return Promise.resolve();
      return removal ??= engine.remove(scope).catch(() => { /* shutdown may already have removed the actor */ });
    };
    const cancelled = new Set<RustStream>();
    const cancelHandle = (handle: RustStream) => {
      if (cancelled.has(handle)) return;
      cancelled.add(handle);
      try { handle.cancel(); } catch { /* best effort during teardown */ }
    };
    const cancel = () => { if (native) cancelHandle(native); };
    signal.addEventListener("abort", cancel, { once: true });
    void (async () => {
      try {
        signal.throwIfAborted();
        if (options.fetch) throw new Error("Cursor Rust transport cannot accept a JavaScript fetch override");
        if (Object.keys(model.headers ?? {}).length || Object.keys(options.headers ?? {}).length) throw new Error("Cursor Rust transport does not support custom HTTP headers (including header suppression)");
        if (options.deferred) throw new Error("Cursor Native does not support deferred responses");
        // Compat has no host request boundary. Resolve only the selected owner's canonical auth,
        // including explicit keys, and never fall through to external/OS credentials.
        if (options.apiKey) secrets.push(options.apiKey);
        const authTimeout = boundedTimeout(this.environment(options.env), "PI_CURSOR_AUTH_TIMEOUT_MS", 25000, 30000);
        const access = compat ? await withDeadline(authSignal => compat.resolveAuth(authSignal), { signal, timeoutMs: authTimeout,
          code: "CURSOR_AUTH_TIMEOUT", message: "Cursor canonical authentication timed out" }) : undefined;
        if (access?.apiKey) secrets.push(access.apiKey);
        signal.throwIfAborted();
        if (compat && !access?.apiKey?.trim()) throw new Error("Cursor compat canonical authentication unavailable; run /login cursor");
        if (compat && options.apiKey?.trim() && accountPartition(options.apiKey.trim()) !== accountPartition(access!.apiKey!.trim())) {
          throw new Error("Cursor compat explicit credential account does not match the selected host");
        }
        const env = this.environment({ ...access?.env, ...options.env });
        const binding = await this.auth.bind(options.apiKey?.trim() || access?.apiKey, env, signal,
          compat ? async refreshSignal => (await withDeadline(authSignal => compat.resolveAuth(authSignal), { signal: refreshSignal,
            timeoutMs: authTimeout, code: "CURSOR_AUTH_TIMEOUT", message: "Cursor canonical authentication timed out" })).apiKey : this.deps.resolveAuth);
        signal.throwIfAborted();
        secrets.push(binding.accessToken);
        const agentUrl = endpoint(env.PI_CURSOR_AGENT_URL ?? env.CURSOR_AGENT_URL ?? model.baseUrl ?? AGENT_URL);
        phase("preparing");
        const transcript = toNativeTranscript(context);
        const workspace = this.session?.workspace ?? resolve(process.cwd());
        // Extensions such as BTW copy this stream closure but supply their own stable session ID.
        // Keep those actors through tool results, separately from both the parent and one-shot summaries.
        const requestSession = typeof options.sessionId === "string" && options.sessionId.trim() ? options.sessionId : undefined;
        const chat = !!this.session && !!requestSession && options.cacheRetention !== "none";
        stateless = !chat;
        const requestKind = compat ? chat ? "compat/chat" : "compat/stateless" : chat ? requestSession === this.session!.sessionId ? "chat" : "child-chat" : "auxiliary/stateless";
        const logicalSession = chat ? compat ? [this.session!.sessionId, compat.owner, requestSession] : [this.session!.sessionId, requestSession] : randomUUID();
        const controlIdentity = chat ? fingerprint([HOST_NAMESPACE, compat?.owner ?? "native", binding.account, agentUrl, workspace, model.id, logicalSession, requestKind]) : undefined;
        pinKey = controlIdentity ? fingerprint([controlIdentity, options.reasoning ?? null]) : undefined;
        if (controlIdentity && life.resetIdentities?.has(controlIdentity)) throw new Error("Cursor request predates this scope's explicit reset; start a new request");
        if (controlIdentity && [...this.scopes.values()].some(s => s.identity === controlIdentity && (s.fenced || s.requests.size))) throw new Error("Cursor scope is fenced or already active");
        const pin = pinKey ? this.pins.get(pinKey) : undefined;
        if ((!pin && controlIdentity && [...this.pins.values()].some(p => p.controlIdentity === controlIdentity)) ||
            (pin && !this.continuesPin(pin, context))) throw new Error("Cursor pending tool handoff does not match this runtime's issued assistant and exact requested route; reset its known scope to abandon it");
        routing = pin ? structuredClone(pin.route) : this.catalog(binding.account, agentUrl).route(model.id, options.reasoning);
        scope = createHash("sha256").update(JSON.stringify([HOST_NAMESPACE, binding.account, model.id, routing.modelId,
          [...(routing.modelParameters ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), routing.maxMode ?? false, agentUrl, workspace, logicalSession, requestKind])).digest("hex");
        if (controlIdentity && [...this.scopes.values()].some(s => s.identity === controlIdentity && s.scope !== scope && s.hasStarted && s.state !== "idle")) {
          throw new Error("Cursor uncertain prior route is retained; reset its known scope before changing routes");
        }
        if (this.leases.has(scope)) throw new Error("Cursor request scope is already active");
        if (chat) {
          priorState = this.scopes.get(scope)?.state;
          known = this.admit(scope, model.id, requestKind, controlIdentity!, life);
        }
        this.leases.set(scope, life);
        const cacheRoot = env.PI_CURSOR_CACHE_DIR ?? env.CURSOR_NATIVE_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cursor-native");
        const original: NativeRequest = { ...transcript, scope, workspace, modelId: routing.modelId,
          ...(routing.modelParameters ? { modelParameters: routing.modelParameters } : {}),
          ...(routing.maxMode !== undefined ? { maxMode: routing.maxMode } : {}),
          // A stateless compat call cannot safely expose a tool whose result cannot resume it.
          toolChoice: compat && stateless ? "none" : options.toolChoice ?? "auto", stateless, cacheDir: join(cacheRoot, "pi", "rust-sessions-v1"), agentUrl,
          idleTimeoutMs: options.timeoutMs === undefined ? duration(env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS, "idle timeout") : hostIdleTimeout(options.timeoutMs),
          connectTimeoutMs: duration(env.PI_CURSOR_CONNECT_TIMEOUT_MS, "connect timeout"),
          maxRetries: duration(options.maxRetries ?? env.PI_CURSOR_MAX_RETRIES, "retry count") };
        if (!isAbsolute(original.cacheDir)) throw new Error("Cursor cache directory must be absolute");
        const payload = structuredClone(original);
        // Freeze routing/security fields even for in-place hook mutation; replacement fields are checked again below.
        if (payload.modelParameters) { for (const parameter of payload.modelParameters) Object.freeze(parameter); Object.freeze(payload.modelParameters); }
        for (const key of protectedKeys) Object.defineProperty(payload, key, { value: payload[key], enumerable: true, writable: false, configurable: false });
        const replacement = options.onPayload ? await withDeadline(() => Promise.resolve(options.onPayload!(payload, model)), { signal,
          timeoutMs: authTimeout, code: "CURSOR_HOOK_TIMEOUT", message: "Cursor payload hook timed out" }) : undefined;
        signal.throwIfAborted();
        if (known?.fenced) throw new Error("Cursor scope is fenced");
        const { request, json } = requestAfterHook(original, replacement === undefined ? payload : replacement);
        if (pin && (fingerprint(actionHistory(request).slice(0, pin.wireLength)) !== pin.wirePrefix ||
            JSON.stringify(actionHistory(request)) !== JSON.stringify(actionHistory(original)))) throw new Error("Cursor payload hook cannot rewrite a pending tool continuation");
        if (compat && stateless && request.toolChoice !== "none") throw new Error("Cursor compat tools require a stable sessionId");
        if (request.prompt.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "file" ||
            (p.type === "tool-result" && isRecord(p.output) && p.output.type === "content" && Array.isArray(p.output.value) && p.output.value.some(v => isRecord(v) && v.type !== "text")))) && !routing.supportsImages) {
          throw new Error("This Cursor model does not advertise image input");
        }
        writer.setTools(request.toolChoice === "none" ? [] : request.tools.map(tool => tool.name));
        if (routing.effort) writer.message.providerThinkingLevel = routing.effort;
        const unsupported = ["temperature", "maxTokens", "samplingParams", "thinkingBudgets", "maxRetryDelayMs", "transport", "websocketConnectTimeoutMs", "metadata", "identity"].filter(key => (options as Record<string, unknown>)[key] !== undefined);
        if (model.samplingParams) unsupported.push("model.samplingParams");
        if (unsupported.length) writer.diagnostic("cursor_native_unsupported_options", { fields: unsupported, action: "not sent; Rust agent protocol has no corresponding control" });
        if (options.onResponse) writer.diagnostic("cursor_native_transport", { onResponse: "unavailable; Rust does not expose HTTP response status/headers" });
        signal.throwIfAborted();
        engine = this.getEngine();
        phase("start");
        if (known) { known.pendingStart = true; known.hasStarted = true; known.mayHaveActions ||= request.toolChoice !== "none" && request.tools.length > 0; }
        // `json` is exactly JSON.stringify(request): parse/stringify of stringify output is stable.
        const pending = pendingStart = engine.start(json, binding.accessToken);
        // Admission survives a cancelled N-API promise until its receiver and cleanup settle.
        void pending.then(handle => { startSettled = true; native = handle; if (signal.aborted) cancelHandle(handle); }, () => { startSettled = true; }).catch(() => {});
        native = await abortable(pending, signal);
        if (known) known.pendingStart = false;
        signal.throwIfAborted(); phase("streaming"); writer.start();
        while (true) {
          const raw = await abortable(native.nextEvent(), signal);
          signal.throwIfAborted();
          if (raw == null) throw new Error("Rust Cursor stream ended without a terminal event");
          const event: unknown = JSON.parse(raw);
          if (!isRecord(event) || typeof event.type !== "string") throw new Error("Malformed Rust Cursor stream event");
          // The transport cannot expose HTTP headers. Do not fabricate onResponse.
          if (options.onProviderStreamEvent) await withDeadline(() => Promise.resolve(options.onProviderStreamEvent!(structuredClone(event), model)), { signal,
            timeoutMs: authTimeout, code: "CURSOR_HOOK_TIMEOUT", message: "Cursor provider event hook timed out" });
          signal.throwIfAborted();
          if (event.type === "native-token-refresh") {
            const token = await abortable(binding.refresh(signal), signal);
            signal.throwIfAborted(); secrets.push(token);
            await abortable(native.setAccessToken(token), signal); continue;
          }
          if (event.type === "native-protocol-diagnostic") {
            // Native diagnostic details are shape-only; do not echo arbitrary provider text into UI/logs.
            writer.diagnostic("cursor_native_protocol", { observed: true }); continue;
          }
          if (writer.accept(event)) {
            safeCompatCleanup = true;
            if (writer.message.stopReason === "toolUse") {
              phase("awaiting-tools");
              if (pinKey && known) {
                const prefix = toNativeTranscript({ ...context, messages: [...context.messages, writer.message] }).prompt.filter(m => m.role !== "system");
                const assistant = actionHistory(toNativeTranscript({ ...context, messages: [writer.message] }));
                const wirePrefix = [...actionHistory(request), ...assistant];
                this.pins.set(pinKey, { controlIdentity: known.identity, route: structuredClone(routing), scope: scope!, prefix: fingerprint(prefix),
                  assistant: assistantIdentity(writer.message), wirePrefix: fingerprint(wirePrefix), wireLength: wirePrefix.length });
              }
            } else {
              phase("idle");
              if (known) known.mayHaveActions = false;
              if (pinKey) this.pins.delete(pinKey);
            }
            break;
          }
        }
      } catch (error) {
        cancel();
        phase(signal.aborted ? "aborted" : "error");
        // Preflight neither creates uncertainty nor clears an existing native error fence.
        if (known && !pendingStart && !known.pendingStart) known.state = priorState ?? "idle";
        if (!signal.aborted) error = operatorHint(error);
        this.lastError = signal.aborted ? "Cursor request aborted" : safeError(error, secrets);
        writer.fail(error, signal.aborted, secrets);
      } finally {
        signal.removeEventListener("abort", cancel);
        release();
        const finish = () => {
          if (known) known.pendingStart = false;
          if (scope && this.leases.get(scope) === life) this.leases.delete(scope);
          known?.requests.delete(life); this.requests.delete(life); life.finish();
        };
        if ((!pendingStart || startSettled) && !stateless) finish();
        else void (async () => {
          try {
            if (pendingStart) { try { native = await pendingStart; if (signal.aborted) cancelHandle(native); } catch { /* rejected start is settled */ } }
            await remove();
          } finally { finish(); }
        })().catch(() => {});
      }
    })();
    return writer.stream;
  }
}
