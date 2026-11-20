import { expect, it, vi } from "vitest";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { RustEngine, RustStream } from "@cursor-harness-provider/native";
import { createNativeModel, REQUEST_KIND_HEADER, SESSION_HEADER } from "../../packages/opencode/src/model.js";

const input = (kind: string, tools = false): LanguageModelV3CallOptions => ({
  headers: { [REQUEST_KIND_HEADER]: kind, [SESSION_HEADER]: "fixture-session:" + kind },
  prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
  ...(tools ? { tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }] } : {}),
});
function handle(events: unknown[]): RustStream {
  const queue = events.map(value => JSON.stringify(value));
  return { nextEvent: vi.fn(async () => queue.shift() ?? null), cancel: vi.fn(), setAccessToken: vi.fn(async () => {}) };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const finish = (reason = "stop") => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage: { inputTokens: {}, outputTokens: {} } });
function fixture(events: unknown[] = [finish()]) {
  const engine: RustEngine = { start: vi.fn(async () => handle(events)), remove: vi.fn(async () => {}), listModels: vi.fn(), shutdown: vi.fn() };
  const model = createNativeModel({ engine, modelId: "auto", workspace: "/tmp/fixture", getAccessToken: async () => "fixture-token" });
  return { model, engine, request: () => JSON.parse(vi.mocked(engine.start).mock.calls.at(-1)![0]) };
}
it.each(["title", "compaction", "generate"])("removes completed %s scopes and uses stateless tool-less requests", async kind => {
  const f = fixture(); await f.model.doGenerate(input(kind));
  expect(f.request().stateless).toBe(true); expect(f.engine.remove).toHaveBeenCalledWith(f.request().scope);
});
it.each(["primary", "generate"])("preserves %s host-permitted tool continuation without native retries", async kind => {
  const f = fixture([{ type: "tool-call", toolCallId: "t", toolName: "read", input: "{}", providerExecuted: false }, finish("tool-calls")]);
  const options = input(kind, true); const result = await f.model.doGenerate(options); const scope = f.request().scope;
  expect(result.content[0]).toMatchObject({ type: "tool-call", providerExecuted: false });
  expect(f.request().stateless).toBe(false); expect(f.engine.remove).not.toHaveBeenCalled();
  vi.mocked(f.engine.start).mockResolvedValueOnce(handle([finish()]));
  await f.model.doGenerate({ ...options, prompt: [...options.prompt,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "read", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t", toolName: "read", output: { type: "text", value: "host allowed" } }] },
  ] });
  expect(f.request().scope).toBe(scope); expect(f.engine.start).toHaveBeenCalledTimes(2);
  expect(f.engine.remove).toHaveBeenCalledTimes(kind === "generate" ? 1 : 0);
});
it.each(["title", "compaction", "generate"])("cleans %s on native error and consumer cancellation", async kind => {
  const f = fixture([{ type: "error", error: "fixture failure" }]);
  await expect(f.model.doGenerate(input(kind))).rejects.toThrow("fixture failure"); expect(f.engine.remove).toHaveBeenCalledTimes(1);
  vi.mocked(f.engine.remove).mockClear(); vi.mocked(f.engine.start).mockResolvedValueOnce(handle([]));
  const result = await f.model.doStream(input(kind)); await result.stream.cancel(); expect(f.engine.remove).toHaveBeenCalledTimes(1);
});
it("cancels and removes a late-started auxiliary actor, not an early nonexistent scope", async () => {
  const f = fixture(); let resolve!: (stream: RustStream) => void;
  vi.mocked(f.engine.start).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const abort = new AbortController(), pending = f.model.doStream({ ...input("generate"), abortSignal: abort.signal });
  await vi.waitFor(() => expect(f.engine.start).toHaveBeenCalledTimes(1)); abort.abort();
  await expect(pending).rejects.toThrow(/abort/i); expect(f.engine.remove).not.toHaveBeenCalled();
  const stream = handle([]); resolve(stream);
  await vi.waitFor(() => expect(f.engine.remove).toHaveBeenCalledTimes(1)); expect(stream.cancel).toHaveBeenCalledTimes(1);
});
it("fences undrained native finish across model instances, then cleans before publishing completion", async () => {
  const eof = deferred<string | null>(), removed = deferred<void>();
  const a = handle([finish()]), b = handle([]);
  vi.mocked(a.nextEvent).mockImplementationOnce(async () => JSON.stringify(finish())).mockImplementationOnce(() => eof.promise);
  let journal: string | undefined = "A", current = a;
  const f = fixture();
  vi.mocked(f.engine.start).mockResolvedValueOnce(a).mockImplementationOnce(async () => { journal = "B"; current = b; return b; });
  vi.mocked(f.engine.remove).mockImplementation(async () => { await removed.promise; current.cancel(); journal = undefined; });
  const other = createNativeModel({ engine: f.engine, modelId: "auto", workspace: "/tmp/fixture", getAccessToken: async () => "fixture-token" });
  const options = input("generate", true);
  const result = await f.model.doStream(options);
  // Native has already released busy and queued finish; host hasn't drained it.
  await expect(other.doStream(options)).rejects.toThrow("scope is already active");
  expect(f.engine.start).toHaveBeenCalledTimes(1); expect(journal).toBe("A");
  const reader = result.stream.getReader(); await reader.read();
  let published = false;
  const terminal = reader.read().then(value => { published = true; return value; });
  await vi.waitFor(() => expect(a.nextEvent).toHaveBeenCalledTimes(2));
  await expect(other.doStream(options)).rejects.toThrow("scope is already active");
  eof.resolve(null);
  await vi.waitFor(() => expect(f.engine.remove).toHaveBeenCalledTimes(1));
  expect(published).toBe(false);
  await expect(other.doStream(options)).rejects.toThrow("scope is already active");
  removed.resolve(); expect((await terminal).value?.type).toBe("finish");
  const newer = await other.doStream(options);
  expect(journal).toBe("B"); expect(b.cancel).not.toHaveBeenCalled();
  // Reading A's EOF after B's admission performs no delayed scope cleanup.
  expect((await reader.read()).done).toBe(true); reader.releaseLock();
  expect(journal).toBe("B"); expect(b.cancel).not.toHaveBeenCalled();
  expect(f.engine.remove).toHaveBeenCalledTimes(1);
  await newer.stream.cancel(); expect(f.engine.remove).toHaveBeenCalledTimes(1);
});
it.each(["resolve", "reject"])("retains admission after host abort until a late start %ss", async settlement => {
  const f = fixture(), late = deferred<RustStream>(), abort = new AbortController();
  vi.mocked(f.engine.start).mockImplementationOnce(() => late.promise);
  const other = createNativeModel({ engine: f.engine, modelId: "auto", workspace: "/tmp/fixture", getAccessToken: async () => "fixture-token" });
  const options = input("generate", true);
  const pending = f.model.doStream({ ...options, abortSignal: abort.signal });
  await vi.waitFor(() => expect(f.engine.start).toHaveBeenCalledTimes(1)); abort.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  await expect(other.doStream(options)).rejects.toThrow("scope is already active");
  expect(f.engine.start).toHaveBeenCalledTimes(1);
  const old = handle([]);
  if (settlement === "resolve") late.resolve(old); else late.reject(new Error("late rejection"));
  await late.promise.catch(() => {});
  if (settlement === "resolve") expect(old.cancel).toHaveBeenCalledTimes(1);
  expect(f.engine.remove).not.toHaveBeenCalled();
  await other.doGenerate(options);
  expect(f.engine.start).toHaveBeenCalledTimes(2);
  // Only B's successful completion removes its ledger, never late A cleanup.
  expect(f.engine.remove).toHaveBeenCalledTimes(1);
});
it("releases admission on synchronous start failure and onSession abort without removing another actor", async () => {
  const f = fixture(), options = input("generate", true);
  vi.mocked(f.engine.start).mockImplementationOnce(() => { throw new Error("sync start failure"); });
  await expect(f.model.doStream(options)).rejects.toThrow("sync start failure");
  const abort = new AbortController();
  const aborting = createNativeModel({ engine: f.engine, modelId: "auto", workspace: "/tmp/fixture", getAccessToken: async () => "fixture-token", onSession: () => abort.abort() });
  await expect(aborting.doStream({ ...options, abortSignal: abort.signal })).rejects.toThrow(/abort/i);
  expect(f.engine.start).toHaveBeenCalledTimes(1); expect(f.engine.remove).not.toHaveBeenCalled();
  await f.model.doGenerate(options);
  expect(f.engine.start).toHaveBeenCalledTimes(2); expect(f.engine.remove).toHaveBeenCalledTimes(1);
});
it("releases admission after failed cleanup without publishing a successful finish", async () => {
  const f = fixture(), options = input("generate", true);
  vi.mocked(f.engine.remove).mockRejectedValueOnce(new Error("cleanup failed"));
  const result = await f.model.doStream(options), reader = result.stream.getReader();
  expect((await reader.read()).value?.type).toBe("stream-start");
  await expect(reader.read()).rejects.toThrow("cleanup failed"); reader.releaseLock();
  await f.model.doGenerate(options);
  expect(f.engine.start).toHaveBeenCalledTimes(2); expect(f.engine.remove).toHaveBeenCalledTimes(2);
});
it("keeps admission and honors host abort while terminal cleanup is pending", async () => {
  const f = fixture(), removed = deferred<void>(), abort = new AbortController(), options = input("generate", true);
  vi.mocked(f.engine.remove).mockImplementationOnce(() => removed.promise);
  const result = await f.model.doStream({ ...options, abortSignal: abort.signal }), reader = result.stream.getReader();
  await reader.read();
  const terminal = reader.read();
  // Register rejection handling before aborting to avoid unhandled rejections.
  const rejected = expect(terminal).rejects.toThrow(/abort/i);
  await vi.waitFor(() => expect(f.engine.remove).toHaveBeenCalledTimes(1)); abort.abort();
  await expect(f.model.doStream(options)).rejects.toThrow("scope is already active");
  removed.resolve(); await rejected; reader.releaseLock();
  await f.model.doGenerate(options);
  expect(f.engine.start).toHaveBeenCalledTimes(2); expect(f.engine.remove).toHaveBeenCalledTimes(2);
});
it("cancels generation on host-side content errors without deleting a durable loop's fence", async () => {
  const f = fixture([{ type: "text-delta", id: "missing", delta: "invalid" }]);
  await expect(f.model.doGenerate(input("generate", true))).rejects.toThrow("no start");
  expect(f.engine.remove).not.toHaveBeenCalled();
  vi.mocked(f.engine.start).mockResolvedValueOnce(handle([finish()]));
  await f.model.doGenerate(input("generate", true));
  expect(f.engine.start).toHaveBeenCalledTimes(2); expect(f.engine.remove).toHaveBeenCalledTimes(1);
});
it("does not turn historical completed tools into a new generate continuation", async () => {
  const f = fixture();
  await f.model.doGenerate({ ...input("generate"), prompt: [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "old", toolName: "read", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "read", output: { type: "text", value: "done" } }] },
    ...input("generate").prompt,
  ] });
  expect(f.request().stateless).toBe(true); expect(f.engine.remove).toHaveBeenCalledTimes(1);
});
it("does not remove another caller's scope on a rejected start, and isolates request kinds", async () => {
  const f = fixture(); vi.mocked(f.engine.start).mockRejectedValueOnce(new Error("start failed"));
  await expect(f.model.doGenerate(input("generate", true))).rejects.toThrow("start failed"); expect(f.engine.remove).not.toHaveBeenCalled();
  const sameSession = { [SESSION_HEADER]: "same-session" };
  await f.model.doGenerate({ ...input("primary", true), headers: { ...sameSession, [REQUEST_KIND_HEADER]: "primary" } }); const primary = f.request().scope;
  await f.model.doGenerate({ ...input("generate", true), headers: { ...sameSession, [REQUEST_KIND_HEADER]: "generate" } }); expect(f.request().scope).not.toBe(primary);
});
