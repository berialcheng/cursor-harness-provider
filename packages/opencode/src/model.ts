import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { inlineImage, nativeReasoning, requestHeader, validateOptions } from "./adapter.js";
import { createRustEngine, type RustEngine, type RustStream } from "@cursor-harness-provider/native";
import { redactSecrets } from "../../../vendor/pi-cursor/src/utils/security.js";

export { nativeVersion, createRustEngine } from "@cursor-harness-provider/native";
export const PROVIDER_ID = "cursor-native";
export const PACKAGE_ID = "@cursor-harness-provider/opencode";
export const SESSION_HEADER = "x-cursor-native-session-id";
export const WORKSPACE_HEADER = "x-cursor-native-directory";
export type AccessTokenProvider = ((options?: { forceRefresh?: boolean; signal?: AbortSignal }) => Promise<string>) & { readonly scope?: string };
export interface NativeModelOptions {
  modelId: string; workspace: string; getAccessToken: AccessTokenProvider;
  bindAccessToken?: () => Promise<AccessTokenProvider>;
  onSession?: (id: string) => void;
  engine?: RustEngine;
  /** Sanitized wire-shape metadata only; never raw frames or credentials. */
  onDiagnostic?: (details: Record<string, unknown>) => void;
}
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
      const suppliedSession = requestHeader(options, SESSION_HEADER);
      const logicalSession = suppliedSession ?? "stateless-" + randomUUID();
      const abort = new AbortController();
      let native: RustStream | undefined, token: string | undefined, scope: string | undefined;
      let ended = false, started = false, terminal = false, released = false;
      let removal: Promise<void> | undefined;
      const removeStatelessScope = () => removal ??= engine.remove(scope!);
      const relay = () => { abort.abort(options.abortSignal?.reason); native?.cancel(); };
      options.abortSignal?.addEventListener("abort", relay, { once: true });
      if (options.abortSignal?.aborted) relay();
      let getAccessToken: AccessTokenProvider;
      const release = async () => {
        if (released) return;
        released = true; options.abortSignal?.removeEventListener("abort", relay);
        if (!suppliedSession && scope && native) await removeStatelessScope();
      };
      try {
        getAccessToken = config.bindAccessToken ? await abortable(config.bindAccessToken(), abort.signal) : config.getAccessToken;
        token = await abortable(getAccessToken({ signal: abort.signal }), abort.signal);
        const account = getAccessToken.scope ?? createHash("sha256").update(token).digest("hex");
        scope = createHash("sha256").update(JSON.stringify(["opencode", account, config.modelId, workspace, logicalSession])).digest("hex");
        if (suppliedSession) config.onSession?.(scope);
        const cache = process.env.OPENCODE_CURSOR_CACHE_DIR;
        const pending = engine.start(JSON.stringify({ scope, modelId: config.modelId, workspace, prompt,
          tools: options.tools ?? [], toolChoice: options.toolChoice?.type ?? "auto", reasoning: nativeReasoning(options),
          stateless: !suppliedSession, cacheDir: cache ? join(cache, "rust-sessions-v1") : undefined }), token);
        // If aborted while the NAPI future resolves, cancel the late native handle too.
        void pending.then(async value => {
          if (!abort.signal.aborted) return;
          value.cancel();
          if (!suppliedSession) await removeStatelessScope();
        }).catch(() => {});
        native = await abortable(pending, abort.signal);
      } catch (error) {
        native?.cancel(); await release();
        throw abort.signal.aborted ? new DOMException("Cursor request aborted", "AbortError") : safe(error, token);
      }
      return { stream: new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          if (ended) return;
          try {
            if (!started) { started = true; controller.enqueue({ type: "stream-start", warnings }); return; }
            while (true) {
              const raw = await abortable(native!.nextEvent(), abort.signal);
              if (raw == null) {
                if (!terminal) throw new Error("Rust Cursor stream ended without terminal event");
                ended = true; await release(); controller.close(); return;
              }
              const event = JSON.parse(raw);
              if (event.type === "native-token-refresh") {
                token = await abortable(getAccessToken({ forceRefresh: true, signal: abort.signal }), abort.signal);
                await abortable(native!.setAccessToken(token), abort.signal); continue;
              }
              if (event.type === "native-protocol-diagnostic") { config.onDiagnostic?.(event.details); continue; }
              if (event.type === "error") throw new Error(String(event.error ?? "Rust Cursor request failed"));
              if (event.type === "finish") terminal = true;
              if (event.type === "response-metadata" && typeof event.timestamp === "string") event.timestamp = new Date(event.timestamp);
              controller.enqueue(event as LanguageModelV3StreamPart); return;
            }
          } catch (error) {
            ended = true; native!.cancel(); await release();
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
        while (true) {
          const { value: p, done } = await reader.read(); if (done) break;
          if (p.type === "stream-start") warnings = p.warnings;
          else if (p.type === "text-start" || p.type === "reasoning-start") { const b = { type: p.type === "text-start" ? "text" as const : "reasoning" as const, text: "" }; blocks.set(p.id, b); content.push(b); }
          else if (p.type === "text-delta" || p.type === "reasoning-delta") { const b = blocks.get(p.id); if (!b) throw new Error("Cursor content delta has no start"); b.text += p.delta; }
          else if (p.type === "tool-call") content.push(p);
          else if (p.type === "finish") { finishReason = p.finishReason; usage = p.usage; providerMetadata = p.providerMetadata; }
          else if (p.type === "error") throw p.error;
        }
        if (!finishReason) throw new Error("Rust Cursor generation ended without finish");
        return { content, finishReason, usage, warnings, providerMetadata };
      } finally { reader.releaseLock(); }
    },
  };
  return model;
}
