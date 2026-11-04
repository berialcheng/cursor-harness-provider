import { describe, expect, it, vi } from "vitest";
import { createNativeModel, SESSION_HEADER, WORKSPACE_HEADER, type NativeStream } from "../reference/opencode/model.js";
import { createAssistantMessageEventStream, type AssistantMessage, type StreamEvent } from "../reference/host/stream.js";
import { getWorkspaceDirectory } from "../reference/host/workspace.js";
import type { CursorNativeStreamConfig } from "../reference/pi-cursor/src/stream/types.js";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
const message = (): AssistantMessage => ({ role: "assistant", content: [], api: "cursor-native", provider: "cursor-native", model: "auto", stopReason: "stop", timestamp: 0,
  usage: { input: 2, output: 1, cacheRead: 8, cacheWrite: 3, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const prompt: LanguageModelV3CallOptions = { prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
function mockFactory(events: (m: AssistantMessage) => StreamEvent[], observe?: (config: CursorNativeStreamConfig) => void) {
  return (config: CursorNativeStreamConfig): NativeStream => {
    observe?.(config);
    return () => {
      const s = createAssistantMessageEventStream(), m = message();
      for (const event of events(m)) s.push(event);
      s.end(m); return s;
    };
  };
}
const textEvents = (m: AssistantMessage): StreamEvent[] => [{ type: "start", partial: m }, { type: "text_start", contentIndex: 0, partial: m }, { type: "text_delta", contentIndex: 0, delta: "你好 PONG", partial: m }, { type: "text_end", contentIndex: 0, content: "你好 PONG", partial: m }, { type: "done", reason: "stop", message: m }];
describe("LanguageModelV3 adapter", () => {
  it("generates correct V3 finish reason, Unicode and non-fabricated cache usage", async () => {
    const model = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken: async () => "test", streamFactory: mockFactory(textEvents) });
    const result = await model.doGenerate(prompt);
    expect(result.content).toEqual([{ type: "text", text: "你好 PONG" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.usage.inputTokens).toEqual({ total: 13, noCache: undefined, cacheRead: undefined, cacheWrite: undefined });
  });
  it("returns tool requests to the host, never claiming provider execution", async () => {
    const model = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken: async () => "test", streamFactory: mockFactory(m => [
      { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "t", name: "read", arguments: { path: "x" } }, partial: m },
      { type: "done", reason: "toolUse", message: m },
    ]) });
    const result = await model.doGenerate(prompt);
    expect(result.finishReason.unified).toBe("tool-calls");
    expect(result.content).toEqual([{ type: "tool-call", toolCallId: "t", toolName: "read", input: '{"path":"x"}', providerExecuted: false }]);
  });
  it("preserves balanced reasoning blocks", async () => {
    const model = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken: async () => "test", streamFactory: mockFactory(m => [
      { type: "thinking_start", contentIndex: 0, partial: m }, { type: "thinking_delta", contentIndex: 0, delta: "consider", partial: m },
      { type: "thinking_end", contentIndex: 0, content: "consider", partial: m }, { type: "done", reason: "stop", message: m },
    ]) });
    expect((await model.doGenerate(prompt)).content).toEqual([{ type: "reasoning", text: "consider" }]);
  });
  it("does not turn an incomplete/error stream into a successful finish", async () => {
    const model = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken: async () => "test", streamFactory: mockFactory(m => [{ type: "start", partial: m }]) });
    await expect(model.doGenerate(prompt)).rejects.toThrow("without a terminal");
    const errorModel = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken: async () => "test", streamFactory: mockFactory(m => [{ type: "error", reason: "error", error: { ...m, errorMessage: "Bearer secret-value" } }]) });
    await expect(errorModel.doGenerate(prompt)).rejects.toThrow("Bearer [redacted]");
  });
  it("rejects pre-aborted requests without resolving credentials", async () => {
    const getAccessToken = vi.fn(async () => "test"), abort = new AbortController(); abort.abort();
    const model = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken });
    await expect(model.doStream({ ...prompt, abortSignal: abort.signal })).rejects.toThrow();
    expect(getAccessToken).not.toHaveBeenCalled();
  });
  it("isolates simultaneous workspace contexts without process.chdir", async () => {
    const seen: string[] = [];
    const factory = (): NativeStream => () => {
      const s = createAssistantMessageEventStream(), m = message();
      void Promise.resolve().then(() => { seen.push(getWorkspaceDirectory()); s.push({ type: "done", reason: "stop", message: m }); s.end(m); });
      return s;
    };
    const model = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken: async () => "test", streamFactory: factory });
    const before = process.cwd();
    await Promise.all(["/tmp/a", "/tmp/b"].map(dir => model.doGenerate({ ...prompt, headers: { [WORKSPACE_HEADER]: encodeURIComponent(dir), [SESSION_HEADER]: dir } })));
    expect(seen.sort()).toEqual(["/tmp/a", "/tmp/b"]); expect(process.cwd()).toBe(before);
  });
  it("scopes protocol sessions by account, model and workspace", async () => {
    let token = "account-a";
    const ids: string[] = [];
    const factory = (): NativeStream => (_model, _context, opts) => {
      ids.push(opts!.sessionId!);
      const stream = createAssistantMessageEventStream(), m = message();
      stream.push({ type: "done", reason: "stop", message: m }); stream.end(m); return stream;
    };
    const config = { modelId: "auto", workspace: "/tmp", getAccessToken: async () => token, streamFactory: factory };
    const model = createNativeModel(config);
    const request = { ...prompt, headers: { [SESSION_HEADER]: "same-logical-session" } };
    await model.doGenerate(request);
    token = "account-b";
    await model.doGenerate(request);
    await model.doGenerate({ ...request, headers: { ...request.headers, [WORKSPACE_HEADER]: encodeURIComponent("/tmp/other") } });
    await createNativeModel({ ...config, modelId: "other" }).doGenerate(request);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every(id => id.startsWith("oc-native-") && !id.includes("account"))).toBe(true);
  });
  it("aborts promptly while credential resolution is still pending", async () => {
    const abort = new AbortController();
    const getAccessToken = vi.fn(() => new Promise<string>(() => {}));
    const model = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken });
    const pending = model.doStream({ ...prompt, abortSignal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });
  it("aborts the native stream when a consumer cancels", async () => {
    let signal: AbortSignal | undefined;
    const factory = (): NativeStream => (_model, _context, opts) => {
      signal = opts?.signal;
      const s = createAssistantMessageEventStream(), m = message();
      signal?.addEventListener("abort", () => { s.push({ type: "error", reason: "aborted", error: m }); s.end(m); }, { once: true });
      s.push({ type: "start", partial: m }); return s;
    };
    const model = createNativeModel({ modelId: "auto", workspace: "/tmp", getAccessToken: async () => "test", streamFactory: factory });
    const result = await model.doStream(prompt); const reader = result.stream.getReader(); await reader.read(); await reader.cancel();
    expect(signal?.aborted).toBe(true);
  });
});
