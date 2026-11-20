import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { inlineImage, nativeReasoning, requestHeader, validateOptions } from "./adapter.js";
import { createRustEngine, type RustEngine, type RustStream } from "@cursor-harness-provider/native";
import { withDeadline } from "@cursor-harness-provider/native/lifecycle";
import { redactSecrets } from "../../../vendor/pi-cursor/src/utils/security.js";

export { nativeVersion, createRustEngine } from "@cursor-harness-provider/native";
export const PROVIDER_ID = "cursor-native";
export const PACKAGE_ID = "@cursor-harness-provider/opencode";
export const SESSION_HEADER = "x-cursor-native-session-id";
export const WORKSPACE_HEADER = "x-cursor-native-directory";
export const REQUEST_KIND_HEADER = "x-cursor-native-request-kind";
export type AccessTokenProvider = ((options?: { forceRefresh?: boolean; signal?: AbortSignal }) => Promise<string>) & { readonly scope?: string };
export interface NativeModelOptions {
  modelId: string; workspace: string; getAccessToken: AccessTokenProvider;
  bindAccessToken?: (options?: { signal?: AbortSignal }) => Promise<AccessTokenProvider>;
  onSession?: (id: string) => void;
  engine?: RustEngine;
  /** Sanitized wire-shape metadata only; never raw frames or credentials. */
  onDiagnostic?: (details: Record<string, unknown>) => void;
}
// Native busy ownership ends before terminal output is drained. Admission must
// therefore be shared by every model using this engine, not by stream handles.
const scopeLeases = new WeakMap<RustEngine, Map<string, symbol>>();
export const unknownUsage = (): LanguageModelV3Usage => ({ inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } });

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new DOMException("Cursor request aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(v => { signal.removeEventListener("abort", onAbort); resolve(v); }, e => { signal.removeEventListener("abort", onAbort); reject(e); });
    if (signal.aborted) onAbort();
  });
}
/** Only serialize host-owned JS values. Rust owns transcript/protocol semantics. */
function hostPrompt(options: LanguageModelV3CallOptions): unknown[] {
  const image = (part: { mediaType: string; data: string | Uint8Array | URL }) => {
    const i = inlineImage(part); return { mediaType: i.mimeType, data: i.data };
  };
  return options.prompt.map(message => {
    if (message.role === "system") return message;
    return { ...message, content: message.content.map(part => {
      if (part.type === "file") return { ...part, ...image(part) };
      if (part.type !== "tool-result" || part.output.type !== "content") return part;
      return { ...part, output: { ...part.output, value: part.output.value.map(item =>
        item.type === "image-data" || item.type === "file-data" ? { ...item, ...image(item) } : item) } };
    }) };
  });
}
function safe(error: unknown, token?: string): Error {
  const value = error instanceof Error ? error.message : String(error);
  return new Error(redactSecrets(token ? value.split(token).join("[REDACTED]") : value));
}
export function createNativeModel(config: NativeModelOptions): LanguageModelV3 {
  const engine = config.engine ?? createRustEngine();
  const model: LanguageModelV3 = {
    specificationVersion: "v3", provider: PROVIDER_ID, modelId: config.modelId, supportedUrls: {},
    async doStream(options) {
      options.abortSignal?.throwIfAborted();
      const warnings = validateOptions(options), prompt = hostPrompt(options);
      const directoryHeader = requestHeader(options, WORKSPACE_HEADER);
      const workspace = directoryHeader ? decodeURIComponent(directoryHeader) : config.workspace;
      if (!isAbsolute(workspace)) throw new Error("Cursor workspace must be an absolute path");
      const kind = requestHeader(options, REQUEST_KIND_HEADER);
      const auxiliary = kind === "title" || kind === "compaction" || kind === "generate";
      // generate can be an SDK tool loop: retain only a pending tool handoff,
      // not a completed generation. The host still executes/permits every tool.
      const lastMessage = options.prompt.at(-1);
      const toolContinuation = lastMessage?.role === "tool" ||
        (lastMessage?.role === "assistant" && lastMessage.content.some(part => part.type === "tool-call"));
      const canContinue = kind !== "title" && kind !== "compaction" &&
        (kind !== "generate" || (options.toolChoice?.type !== "none" && !!options.tools?.length) || toolContinuation);
      const suppliedSession = canContinue ? requestHeader(options, SESSION_HEADER) : undefined;
      const logicalSession = suppliedSession ?? "stateless-" + randomUUID();
      const abort = new AbortController();
      let native: RustStream | undefined, token: string | undefined, scope: string | undefined;
      let ended = false, started = false, releaseRequested = false, toolHandoff = false;
      let pending: Promise<RustStream> | undefined, startSettled = false;
      let lease: symbol | undefined, cleanup: Promise<void> | undefined;
      const ownsScope = () => !!scope && !!lease && scopeLeases.get(engine)?.get(scope) === lease;
      const relay = () => {
        abort.abort(options.abortSignal?.reason); native?.cancel();
        void release().catch(() => {});
      };
      const release = (completed = false): Promise<void> => {
        releaseRequested = true;
        // Abort returns promptly, but a pending start retains admission until it
        // settles. Its late handle cannot remove a newer caller's actor/ledger.
        if (lease && !startSettled) return Promise.resolve();
        return cleanup ??= (async () => {
          try {
            // Failed/cancelled durable loops and tool handoffs keep their fences.
            if (ownsScope() && native && (!suppliedSession || (auxiliary && completed && !toolHandoff))) await engine.remove(scope!);
          } finally {
            options.abortSignal?.removeEventListener("abort", relay);
            if (ownsScope()) scopeLeases.get(engine)!.delete(scope!);
          }
        })();
      };
      options.abortSignal?.addEventListener("abort", relay, { once: true });
      if (options.abortSignal?.aborted) relay();
      const configuredAuthTimeout = Number(process.env.OPENCODE_CURSOR_AUTH_TIMEOUT_MS?.trim() || 25000);
      const authDeadline = { signal: abort.signal,
        timeoutMs: Number.isFinite(configuredAuthTimeout) ? Math.max(1, Math.min(30000, configuredAuthTimeout)) : 25000,
        code: "CURSOR_AUTH_TIMEOUT", message: "Cursor authentication timed out; reconnect Cursor Native" };
      let getAccessToken: AccessTokenProvider;
      try {
        const initial = await withDeadline(async boundedSignal => {
          const provider = config.bindAccessToken ? await config.bindAccessToken({ signal: boundedSignal }) : config.getAccessToken;
          boundedSignal.throwIfAborted();
          const accessToken = await provider({ signal: boundedSignal });
          boundedSignal.throwIfAborted();
          return { provider, accessToken };
        }, authDeadline);
        abort.signal.throwIfAborted();
        getAccessToken = initial.provider; token = initial.accessToken;
        const account = getAccessToken.scope ?? createHash("sha256").update(token).digest("hex");
        scope = createHash("sha256").update(JSON.stringify(["opencode", account, config.modelId, workspace, kind ?? "primary", logicalSession])).digest("hex");
        abort.signal.throwIfAborted();
        let leases = scopeLeases.get(engine);
        if (!leases) scopeLeases.set(engine, leases = new Map());
        if (leases.has(scope)) throw new Error("Cursor request scope is already active");
        lease = Symbol(); leases.set(scope, lease);
        if (suppliedSession) config.onSession?.(scope);
        abort.signal.throwIfAborted();
        const cache = process.env.OPENCODE_CURSOR_CACHE_DIR;
        pending = engine.start(JSON.stringify({ scope, modelId: config.modelId, workspace, prompt,
          tools: options.tools ?? [], toolChoice: options.toolChoice?.type ?? "auto", reasoning: nativeReasoning(options),
          stateless: !suppliedSession, cacheDir: cache ? join(cache, "rust-sessions-v1") : undefined }), token);
        // If aborted while the NAPI future resolves, cancel the late native handle too.
        void pending.then(async value => {
          startSettled = true; native = value;
          if (!abort.signal.aborted && !releaseRequested) return;
          value.cancel(); await release();
        }, async () => { startSettled = true; await release(); }).catch(() => {});
        native = await abortable(pending, abort.signal);
        abort.signal.throwIfAborted();
      } catch (error) {
        if (!pending) startSettled = true;
        native?.cancel();
        try { await release(); } catch (cleanupError) { error = cleanupError; }
        throw abort.signal.aborted ? new DOMException("Cursor request aborted", "AbortError") : safe(error, token);
      }
      return { stream: new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          if (ended) return;
          try {
            abort.signal.throwIfAborted();
            if (!started) { started = true; controller.enqueue({ type: "stream-start", warnings }); return; }
            while (true) {
              abort.signal.throwIfAborted();
              const raw = await abortable(native!.nextEvent(), abort.signal);
              abort.signal.throwIfAborted();
              if (raw == null) throw new Error("Rust Cursor stream ended without terminal event");
              const event = JSON.parse(raw);
              if (event.type === "native-token-refresh") {
                await withDeadline(async boundedSignal => {
                  const refreshed = await getAccessToken({ forceRefresh: true, signal: boundedSignal });
                  boundedSignal.throwIfAborted();
                  token = refreshed;
                  await native!.setAccessToken(refreshed);
                  boundedSignal.throwIfAborted();
                }, authDeadline);
                abort.signal.throwIfAborted(); continue;
              }
              if (event.type === "native-protocol-diagnostic") { config.onDiagnostic?.(event.details); continue; }
              if (event.type === "error") throw new Error(String(event.error ?? "Rust Cursor request failed"));
              if (event.type === "finish") {
                toolHandoff = event.finishReason?.unified === "tool-calls";
                // EOF validates terminality; cleanup and admission release happen
                // before the host can observe completion or start a continuation.
                const trailing = await abortable(native!.nextEvent(), abort.signal);
                abort.signal.throwIfAborted();
                if (trailing != null) throw new Error("Rust Cursor stream emitted an event after terminal event");
                await release(true); abort.signal.throwIfAborted();
                ended = true; controller.enqueue(event as LanguageModelV3StreamPart); controller.close(); return;
              }
              if (event.type === "response-metadata" && typeof event.timestamp === "string") event.timestamp = new Date(event.timestamp);
              controller.enqueue(event as LanguageModelV3StreamPart); return;
            }
          } catch (error) {
            ended = true; native!.cancel();
            try { await release(); } catch (cleanupError) { error = cleanupError; }
            controller.error(abort.signal.aborted ? new DOMException("Cursor request aborted", "AbortError") : safe(error, token));
          }
        },
        async cancel() { ended = true; abort.abort(); native!.cancel(); await release(); },
      }) };
    },
    async doGenerate(options): Promise<LanguageModelV3GenerateResult> {
      const { stream } = await model.doStream(options), reader = stream.getReader();
      const content: LanguageModelV3Content[] = [], blocks = new Map<string, { type: "text" | "reasoning"; text: string }>();
      let finishReason: LanguageModelV3GenerateResult["finishReason"] | undefined;
      let usage = unknownUsage(), warnings: LanguageModelV3GenerateResult["warnings"] = [], providerMetadata;
      try {
        options.abortSignal?.throwIfAborted();
        while (true) {
          const { value: p, done } = await reader.read();
          options.abortSignal?.throwIfAborted();
          if (done) break;
          if (p.type === "stream-start") warnings = p.warnings;
          else if (p.type === "text-start" || p.type === "reasoning-start") { const b = { type: p.type === "text-start" ? "text" as const : "reasoning" as const, text: "" }; blocks.set(p.id, b); content.push(b); }
          else if (p.type === "text-delta" || p.type === "reasoning-delta") { const b = blocks.get(p.id); if (!b) throw new Error("Cursor content delta has no start"); b.text += p.delta; }
          else if (p.type === "tool-call") content.push(p);
          else if (p.type === "finish") { finishReason = p.finishReason; usage = p.usage; providerMetadata = p.providerMetadata; }
          else if (p.type === "error") throw p.error;
        }
        if (!finishReason) throw new Error("Rust Cursor generation ended without finish");
        return { content, finishReason, usage, warnings, providerMetadata };
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    },
  };
  return model;
}
