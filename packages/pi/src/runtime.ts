import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRustEngine, nativeVersion, type RustEngine, type RustStream } from "@cursor-native/native";
import type { Api, Model, SimpleStreamOptions, TranscriptContext, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CursorAuth, type ResolveAuth } from "./auth/index.js";
import { AGENT_URL, HOST_NAMESPACE } from "./constants.js";
import { CursorCatalog } from "./models.js";
import { PiEventWriter } from "./events.js";
import { abortable, isRecord, safeError } from "./security.js";
import { toNativeTranscript, validateTranscript, type NativeTranscript } from "./transcript.js";

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
  stateless: boolean; cacheDir: string; agentUrl: string;
  idleTimeoutMs?: number; connectTimeoutMs?: number; maxRetries?: number;
}
const protectedKeys = ["scope", "modelId", "workspace", "stateless", "cacheDir", "agentUrl", "idleTimeoutMs", "connectTimeoutMs", "maxRetries"] as const;

function duration(value: unknown, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > 3600000) throw new Error(`Invalid ${name}`);
  return number;
}
function endpoint(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash) throw new Error("Cursor endpoint must be HTTPS (or loopback HTTP), without credentials/query/hash");
  return url.href.replace(/\/$/, "");
}
function requestAfterHook(original: NativeRequest, replacement: unknown): NativeRequest {
  const candidate: unknown = JSON.parse(JSON.stringify(replacement));
  if (!isRecord(candidate)) throw new Error("Cursor payload hook must return a normalized request object");
  const allowed = new Set<string>([...protectedKeys, "prompt", "tools", "toolChoice"]);
  if (Object.keys(candidate).some(key => !allowed.has(key))) throw new Error("Cursor payload hook returned an unsupported field (auth and model routing are immutable)");
  for (const key of protectedKeys) if (candidate[key] !== original[key]) throw new Error(`Cursor payload hook cannot change ${key}`);
  if (candidate.toolChoice !== "auto" && candidate.toolChoice !== "none") throw new Error("Cursor supports auto/none tool choice only");
  validateTranscript(candidate);
  return candidate as unknown as NativeRequest;
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
  private lastError: string | undefined;
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
  private catalog(account: string): CursorCatalog {
    let catalog = this.catalogs.get(account);
    if (!catalog) { catalog = new CursorCatalog(); catalog.ensureAccount(account); this.catalogs.set(account, catalog); }
    this.activeAccount = account;
    return catalog;
  }
  definitions(): ProviderModelConfig[] { return (this.activeAccount ? this.catalogs.get(this.activeAccount)! : this.bootstrap).definitions(); }
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
      const raw = await abortable(this.getEngine().listModels(token, endpoint(env.PI_CURSOR_AGENT_URL ?? env.CURSOR_AGENT_URL ?? url ?? AGENT_URL)), controller.signal);
      controller.signal.throwIfAborted();
      return this.catalog(bound.account).apply(raw, bound.account);
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
      `models=${this.definitions().length}`, "tools=Pi permission gate only; native local actions forbidden",
      "httpHeaders=not exposed by Rust; onResponse unavailable", "catalog=exact IDs only; Max/parameterized models excluded",
      "tokens/cache/billing=unreported unless Rust explicitly reports them; zero is not verified quota",
      `lastError=${this.lastError ?? "none"}`].join("\n");
  }
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    const engine = this.engine; this.engine = undefined;
    try { engine?.shutdown(); } finally { this.auth.clear(); this.catalogs.clear(); this.activeAccount = undefined; }
  }
  readonly streamSimple = (model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream => {
    const writer = new PiEventWriter(model);
    const { controller, release } = this.operation(options.signal);
    const signal = controller.signal;
    let native: RustStream | undefined, engine: RustEngine | undefined, scope: string | undefined, stateless = true;
    let removal: Promise<void> | undefined;
    const secrets: string[] = [];
    const remove = (lateHandle = false): Promise<void> => {
      if (!engine || !scope || !stateless || (!native && !lateHandle)) return Promise.resolve();
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
        const env = this.environment(options.env);
        const binding = await this.auth.bind(options.apiKey, env, signal, this.deps.resolveAuth);
        signal.throwIfAborted();
        secrets.push(binding.accessToken);
        const routing = this.catalog(binding.account).route(model.id, options.reasoning);
        const transcript = toNativeTranscript(context);
        const workspace = this.session?.workspace ?? resolve(process.cwd());
        // Pi summaries use cacheRetention:none, sometimes with the chat session ID. Never share that checkpoint.
        const chat = !!this.session && options.sessionId === this.session.sessionId && options.cacheRetention !== "none";
        stateless = !chat;
        const requestKind = chat ? "chat" : "auxiliary/stateless";
        const logicalSession = chat ? this.session!.sessionId : randomUUID();
        scope = createHash("sha256").update(JSON.stringify([HOST_NAMESPACE, binding.account, model.id, routing.modelId, workspace, logicalSession, requestKind])).digest("hex");
        const cacheRoot = env.PI_CURSOR_CACHE_DIR ?? env.CURSOR_NATIVE_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cursor-native");
        const original: NativeRequest = { ...transcript, scope, workspace, modelId: routing.modelId,
          toolChoice: options.toolChoice ?? "auto", stateless, cacheDir: join(cacheRoot, "pi", "rust-sessions-v1"),
          agentUrl: endpoint(env.PI_CURSOR_AGENT_URL ?? env.CURSOR_AGENT_URL ?? model.baseUrl ?? AGENT_URL),
          idleTimeoutMs: duration(options.timeoutMs ?? env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS, "idle timeout"),
          connectTimeoutMs: duration(env.PI_CURSOR_CONNECT_TIMEOUT_MS, "connect timeout"),
          maxRetries: duration(options.maxRetries ?? env.PI_CURSOR_MAX_RETRIES, "retry count") };
        if (!isAbsolute(original.cacheDir)) throw new Error("Cursor cache directory must be absolute");
        const payload = structuredClone(original);
        // Freeze routing/security fields even for in-place hook mutation; replacement fields are checked again below.
        for (const key of protectedKeys) Object.defineProperty(payload, key, { value: payload[key], enumerable: true, writable: false, configurable: false });
        const replacement = options.onPayload ? await abortable(Promise.resolve(options.onPayload(payload, model)), signal) : undefined;
        const request = requestAfterHook(original, replacement === undefined ? payload : replacement);
        if (request.prompt.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "file" ||
            (p.type === "tool-result" && isRecord(p.output) && p.output.type === "content" && Array.isArray(p.output.value) && p.output.value.some(v => isRecord(v) && v.type !== "text")))) && !model.input.includes("image")) {
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
        const pending = engine.start(JSON.stringify(request), binding.accessToken);
        // A cancelled N-API start can still resolve: dispose the late receiver, not merely the JS promise.
        void pending.then(async handle => { if (signal.aborted) { cancelHandle(handle); await remove(true); } }).catch(() => {});
        native = await abortable(pending, signal);
        signal.throwIfAborted(); writer.start();
        while (true) {
          const raw = await abortable(native.nextEvent(), signal);
          signal.throwIfAborted();
          if (raw == null) throw new Error("Rust Cursor stream ended without a terminal event");
          const event: unknown = JSON.parse(raw);
          if (!isRecord(event) || typeof event.type !== "string") throw new Error("Malformed Rust Cursor stream event");
          // The transport cannot expose HTTP headers. Do not fabricate onResponse.
          if (options.onProviderStreamEvent) await abortable(Promise.resolve(options.onProviderStreamEvent(structuredClone(event), model)), signal);
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
          if (writer.accept(event)) break;
        }
      } catch (error) {
        cancel();
        this.lastError = signal.aborted ? "Cursor request aborted" : safeError(error, secrets);
        writer.fail(error, signal.aborted, secrets);
      } finally {
        signal.removeEventListener("abort", cancel);
        release(); await remove();
      }
    })();
    return writer.stream;
  };
}
