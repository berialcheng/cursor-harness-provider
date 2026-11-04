import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { createCursorNativeStream, cleanupSessionState } from "../pi-cursor/src/stream/native-core.js";
import { redactSecrets } from "../pi-cursor/src/utils/security.js";
import type { AssistantMessage, Model, StreamEvent } from "../host/stream.js";
import { withWorkspace } from "../host/workspace.js";
import { toNativeContext, validateOptions, requestHeader, nativeReasoning } from "./adapter.js";

export const PROVIDER_ID = "cursor-native";
export const PACKAGE_ID = "opencode-cursor-native";
export const SESSION_HEADER = "x-cursor-native-session-id";
export const WORKSPACE_HEADER = "x-cursor-native-directory";
export type NativeStream = ReturnType<typeof createCursorNativeStream>;
export type AccessTokenProvider = ((options?: { forceRefresh?: boolean; signal?: AbortSignal }) => Promise<string>) & { readonly scope?: string };
export interface NativeModelOptions {
  modelId: string;
  workspace: string;
  getAccessToken: AccessTokenProvider;
  /** Bind one account for the whole request, including retries. */
  bindAccessToken?: () => Promise<NativeModelOptions["getAccessToken"]>;
  onSession?: (id: string) => void;
  /** Test injection, not a second production transport. */
  streamFactory?: typeof createCursorNativeStream;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new DOMException("Cursor request aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => { signal.removeEventListener("abort", onAbort); reject(error); });
    if (signal.aborted) onAbort();
  });
}

function usage(message: AssistantMessage): LanguageModelV3Usage {
  // Cursor does not report a verified per-turn cache split. Do not expose the
  // vendored heuristic as authoritative provider/cache billing.
  const input = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  return { inputTokens: { total: input || undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: message.usage.output || undefined, text: undefined, reasoning: undefined } };
}
export const unknownUsage = (): LanguageModelV3Usage => ({
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

async function* convertEvents(events: AsyncIterable<StreamEvent>, modelId: string): AsyncGenerator<LanguageModelV3StreamPart> {
  let terminal = false;
  for await (const event of events) {
    const id = "contentIndex" in event ? String(event.contentIndex) : "";
    switch (event.type) {
      case "start": yield { type: "response-metadata", id: randomUUID(), modelId, timestamp: new Date() }; break;
      case "text_start": yield { type: "text-start", id }; break;
      case "text_delta": yield { type: "text-delta", id, delta: event.delta }; break;
      case "text_end": yield { type: "text-end", id }; break;
      case "thinking_start": yield { type: "reasoning-start", id }; break;
      case "thinking_delta": yield { type: "reasoning-delta", id, delta: event.delta }; break;
      case "thinking_end": yield { type: "reasoning-end", id }; break;
      case "toolcall_end": {
        const t = event.toolCall;
        yield { type: "tool-input-start", id: t.id, toolName: t.name };
        yield { type: "tool-input-delta", id: t.id, delta: JSON.stringify(t.arguments) };
        yield { type: "tool-input-end", id: t.id };
        yield { type: "tool-call", toolCallId: t.id, toolName: t.name, input: JSON.stringify(t.arguments), providerExecuted: false };
        break;
      }
      case "done":
        terminal = true;
        yield { type: "finish", finishReason: { unified: event.reason === "toolUse" ? "tool-calls" : event.reason, raw: event.reason }, usage: usage(event.message),
          providerMetadata: { cursorNative: { cacheUsage: "unreported", billingUsage: "not-verified" } } };
        return;
      case "error":
        terminal = true;
        throw event.reason === "aborted" ? new DOMException("Cursor request aborted", "AbortError") : new Error(redactSecrets(event.error.errorMessage ?? "Cursor request failed"));
    }
  }
  if (!terminal) throw new Error("Cursor stream ended without a terminal event");
}

export function createNativeModel(config: NativeModelOptions): LanguageModelV3 {
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: PROVIDER_ID,
    modelId: config.modelId,
    supportedUrls: {},
    async doStream(options) {
      options.abortSignal?.throwIfAborted();
      const warnings = validateOptions(options);
      const context = toNativeContext(options);
      const directoryValue = requestHeader(options, WORKSPACE_HEADER);
      const directory = directoryValue ? decodeURIComponent(directoryValue) : config.workspace;
      if (!isAbsolute(directory)) throw new Error("Cursor workspace must be an absolute path");
      const suppliedSession = requestHeader(options, SESSION_HEADER);
      const logicalSessionId = suppliedSession ?? "stateless-" + randomUUID();
      const abort = new AbortController();
      const relayAbort = () => abort.abort(options.abortSignal?.reason);
      options.abortSignal?.addEventListener("abort", relayAbort, { once: true });
      if (options.abortSignal?.aborted) relayAbort();
      let getAccessToken: AccessTokenProvider;
      let accountScope: string;
      let initialToken: string | undefined;
      try {
        getAccessToken = config.bindAccessToken ? await abortable(config.bindAccessToken(), abort.signal) : config.getAccessToken;
        abort.signal.throwIfAborted();
        // The upstream engine keys parked bridges by session ID alone. Scope
        // it ourselves so account/model/workspace switches cannot reuse an
        // old account's checkpoint or pending tool continuation.
        if (getAccessToken.scope) accountScope = getAccessToken.scope;
        else {
          initialToken = await abortable(getAccessToken({ signal: abort.signal }), abort.signal);
          accountScope = createHash("sha256").update(initialToken).digest("hex");
        }
      } catch (error) {
        abort.abort();
        options.abortSignal?.removeEventListener("abort", relayAbort);
        throw error instanceof DOMException ? error : new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
      }
      const sessionId = "oc-native-" + createHash("sha256").update(JSON.stringify([accountScope, config.modelId, directory, logicalSessionId])).digest("hex");
      if (suppliedSession) config.onSession?.(sessionId);
      const streamFn = (config.streamFactory ?? createCursorNativeStream)({
        getAccessToken: (refresh) => {
          if (initialToken && !refresh?.forceRefresh) {
            const token = initialToken; initialToken = undefined;
            return Promise.resolve(token);
          }
          return abortable(getAccessToken({ ...refresh, signal: abort.signal }), abort.signal);
        },
      });
      const nativeModel: Model = { id: config.modelId, provider: PROVIDER_ID, api: PROVIDER_ID, reasoning: true, compat: { supportsReasoningEffort: true } };
      const events = withWorkspace(directory, () => streamFn(nativeModel, context, {
        signal: abort.signal, sessionId, reasoning: nativeReasoning(options),
        toolChoice: options.toolChoice?.type,
      }));
      const iterator = convertEvents(events, config.modelId);
      let started = false;
      let ended = false;
      const release = () => {
        options.abortSignal?.removeEventListener("abort", relayAbort);
        if (!suppliedSession) cleanupSessionState(sessionId);
      };
      return { stream: new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          if (ended) return;
          try {
            if (!started) { started = true; controller.enqueue({ type: "stream-start", warnings }); return; }
            const next = await iterator.next();
            if (next.done) { ended = true; release(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) {
            ended = true; abort.abort(); release();
            controller.error(error instanceof DOMException ? error : abort.signal.aborted && options.abortSignal?.aborted ? new DOMException("Cursor request aborted", "AbortError") : new Error(redactSecrets(error instanceof Error ? error.message : String(error))));
          }
        },
        async cancel() {
          ended = true; abort.abort(); release();
          await iterator.return(undefined);
        },
      }) };
    },
    async doGenerate(options): Promise<LanguageModelV3GenerateResult> {
      const result = await model.doStream(options);
      const reader = result.stream.getReader();
      const content: LanguageModelV3Content[] = [];
      const blocks = new Map<string, { type: "text" | "reasoning"; text: string }>();
      let finishReason: LanguageModelV3GenerateResult["finishReason"] | undefined;
      let finalUsage = unknownUsage();
      let warnings: LanguageModelV3GenerateResult["warnings"] = [];
      try {
        while (true) {
          const { done, value: part } = await reader.read();
          if (done) break;
          if (part.type === "stream-start") warnings = part.warnings;
          else if (part.type === "text-start" || part.type === "reasoning-start") {
            const block = { type: part.type === "text-start" ? "text" as const : "reasoning" as const, text: "" };
            blocks.set(part.id, block); content.push(block);
          } else if (part.type === "text-delta" || part.type === "reasoning-delta") {
            const block = blocks.get(part.id);
            if (!block) throw new Error("Cursor content delta has no start event");
            block.text += part.delta;
          } else if (part.type === "tool-call") content.push(part);
          else if (part.type === "finish") { finishReason = part.finishReason; finalUsage = part.usage; }
          else if (part.type === "error") throw part.error;
        }
        if (!finishReason) throw new Error("Cursor generation ended without finish");
        return { content, finishReason, usage: finalUsage, warnings };
      } finally { reader.releaseLock(); }
    },
  };
  return model;
}
