import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { RustEngine, RustStream } from "@cursor-harness-provider/native";
import { DeadlineError, withDeadline } from "@cursor-harness-provider/native/lifecycle";
import { createNativeModel, SESSION_HEADER, type AccessTokenProvider } from "../packages/opencode/src/model.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deadline = (signal?: AbortSignal, timeoutMs = 10) => ({ signal, timeoutMs, code: "FIXTURE_DEADLINE", message: "Fixture wait timed out" });

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("shared asynchronous deadlines", () => {
  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid timeout %s without running work or scheduling timers", async timeout => {
    const run = vi.fn(async () => "unused"), parent = new AbortController();
    await expect(withDeadline(run, deadline(parent.signal, timeout))).rejects.toThrow(/positive and finite/);
    expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
  it("gives pre-existing parent cancellation precedence, including over invalid options", async () => {
    const parent = new AbortController(), reason = new Error("fixture caller cancellation"), run = vi.fn(async () => "unused");
    parent.abort(reason);
    await expect(withDeadline(run, deadline(parent.signal, 0))).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
  it.each(["resolve", "reject", "throw"])("cleans timers/listeners on ordinary %s", async settlement => {
    const parent = new AbortController(), failure = new Error("fixture work failure");
    let bounded!: AbortSignal;
    const pending = withDeadline(signal => {
      bounded = signal;
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
      if (settlement === "throw") throw failure;
      return settlement === "resolve" ? Promise.resolve(42) : Promise.reject(failure);
    }, deadline(parent.signal));
    if (settlement === "resolve") await expect(pending).resolves.toBe(42);
    else await expect(pending).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    parent.abort(); expect(bounded.aborted).toBe(false);
  });
  it.each(["resolve", "reject"])("cancels ignored work and safely observes its late %s", async settlement => {
    const parent = new AbortController(), late = deferred<string>();
    let bounded!: AbortSignal;
    const pending = withDeadline(signal => { bounded = signal; return late.promise; }, deadline(parent.signal));
    const rejected = expect(pending).rejects.toMatchObject({ name: "DeadlineError", code: "FIXTURE_DEADLINE", message: "Fixture wait timed out" });
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(bounded.aborted).toBe(true); expect(bounded.reason).toBeInstanceOf(DeadlineError);
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    if (settlement === "resolve") late.resolve("late"); else late.reject(new Error("late fixture rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps parent cancellation authoritative before timeout and before a settled promise continuation", async () => {
    const parent = new AbortController(), late = deferred<string>(), reason = new DOMException("Fixture stop", "AbortError");
    let bounded!: AbortSignal;
    const pending = withDeadline(signal => { bounded = signal; return late.promise; }, deadline(parent.signal));
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(9); late.resolve("already fulfilled"); parent.abort(reason);
    await rejected;
    expect(bounded.reason).toBe(reason); expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
  it("handles synchronous parent abort during work even if that work rejects later", async () => {
    const parent = new AbortController(), reason = new Error("fixture synchronous abort");
    const pending = withDeadline(() => { parent.abort(reason); return Promise.reject(new Error("late work failure")); }, deadline(parent.signal));
    await expect(pending).rejects.toBe(reason); await flush();
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
  it("does not overflow very long positive finite timeouts into immediate expiration", async () => {
    const parent = new AbortController(), reason = new Error("fixture cleanup");
    const pending = withDeadline(() => new Promise<never>(() => {}), deadline(parent.signal, Number.MAX_VALUE));
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1); parent.abort(reason); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps an awaited, otherwise idle headless process alive until the deadline", async () => {
    vi.useRealTimers();
    const source = import.meta.resolve("@cursor-harness-provider/native/lifecycle");
    const script = `import { withDeadline } from ${JSON.stringify(source)};
      await withDeadline(() => new Promise(() => {}), { timeoutMs: 20, code: "HEADLESS_BOUND", message: "fixture" })
        .catch(error => { console.log(error.code); });`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 3000, env: {} });
    expect(stdout.trim()).toBe("HEADLESS_BOUND");
  });
});

const finish = () => ({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} } });
const input = (abortSignal?: AbortSignal): LanguageModelV3CallOptions => ({
  abortSignal, headers: { [SESSION_HEADER]: "fixture-auth-session" },
  prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
});
function handle(events: unknown[] = [finish()]): RustStream {
  const queue = events.map(event => JSON.stringify(event));
  return { nextEvent: vi.fn(async () => queue.shift() ?? null), cancel: vi.fn(), setAccessToken: vi.fn(async () => {}) };
}
function fixture(native = handle(), getAccessToken: AccessTokenProvider = async () => "fixture-initial") {
  const engine: RustEngine = { start: vi.fn(async () => native), remove: vi.fn(async () => {}), listModels: vi.fn(), shutdown: vi.fn() };
  const config = { engine, workspace: "/tmp/auth-deadline-fixture", modelId: "auto", getAccessToken };
  return { engine, config, model: createNativeModel(config) };
}

describe("OpenCode auth deadlines (fixture engine only)", () => {
  beforeEach(() => vi.stubEnv("OPENCODE_CURSOR_AUTH_TIMEOUT_MS", "10"));
  it.each([
    { type: "tool-call", toolCallId: "fixture-call", toolName: "fixture-tool", input: "{}" },
    { type: "native-protocol-diagnostic", details: { fixture: true } },
  ])("does not publish $type when abort follows settlement but precedes the await continuation", async event => {
    const late = deferred<string | null>(), native = handle(), f = fixture(native), parent = new AbortController();
    vi.mocked(native.nextEvent).mockImplementationOnce(() => late.promise);
    const onDiagnostic = vi.fn(), model = createNativeModel({ ...f.config, onDiagnostic });
    const { stream } = await model.doStream(input(parent.signal)), reader = stream.getReader();
    expect((await reader.read()).value?.type).toBe("stream-start");
    await flush(); expect(native.nextEvent).toHaveBeenCalledOnce();
    const published: unknown[] = [];
    const read = reader.read().then(value => { published.push(value); return value; });
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    // abortable's already-registered reaction resolves its promise and removes
    // its listener first; this reaction aborts before pull's continuation runs.
    const aborted = late.promise.then(() => parent.abort());
    late.resolve(JSON.stringify(event));
    await aborted; await rejected; reader.releaseLock();
    expect(published).toEqual([]); expect(onDiagnostic).not.toHaveBeenCalled();
    expect(native.cancel).toHaveBeenCalled(); expect(f.engine.remove).not.toHaveBeenCalled();
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    // Admission is still released, without deleting the durable request fence.
    vi.mocked(f.engine.start).mockResolvedValueOnce(handle());
    await model.doGenerate(input()); expect(f.engine.start).toHaveBeenCalledTimes(2);
  });
  it("bounds a never-settling initial binding; a late provider cannot resolve tokens or start native work", async () => {
    const late = deferred<AccessTokenProvider>(), provider = vi.fn(async () => "late-token"), parent = new AbortController();
    const f = fixture(), bindAccessToken = vi.fn(() => late.promise);
    const model = createNativeModel({ ...f.config, bindAccessToken });
    const pending = model.doStream(input(parent.signal)), rejected = expect(pending).rejects.toThrow(/authentication timed out/);
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(bindAccessToken).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) }); expect(provider).not.toHaveBeenCalled();
    expect(f.engine.start).not.toHaveBeenCalled(); expect(f.engine.remove).not.toHaveBeenCalled();
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    late.resolve(provider); await flush();
    expect(provider).not.toHaveBeenCalled(); expect(f.engine.start).not.toHaveBeenCalled();
    bindAccessToken.mockResolvedValueOnce(provider);
    await model.doGenerate(input()); expect(f.engine.start).toHaveBeenCalledOnce();
  });
  it("uses one finite budget for binding plus initial resolution and does not compute an account from late auth", async () => {
    const late = deferred<string>(), provider = vi.fn(() => late.promise), scope = vi.fn(() => "fixture-account");
    Object.defineProperty(provider, "scope", { get: scope });
    const f = fixture(), bindAccessToken = vi.fn(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 6)); return provider;
    });
    const model = createNativeModel({ ...f.config, bindAccessToken }), pending = model.doStream(input());
    const rejected = expect(pending).rejects.toThrow(/authentication timed out/);
    await vi.advanceTimersByTimeAsync(6); expect(provider).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4); await rejected;
    late.resolve("late-token"); await flush();
    expect(scope).not.toHaveBeenCalled(); expect(f.engine.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends on auth timeout even with a native error queued behind refresh; late auth cannot update the handle or poison a new request", async () => {
    const late = deferred<string>(), provider = Object.assign(vi.fn<AccessTokenProvider>(async options => options?.forceRefresh ? late.promise : "fixture-initial"), { scope: "fixture-account" });
    const native = handle([{ type: "native-token-refresh" }, { type: "error", error: "queued native failure" }]), f = fixture(native, provider);
    const parent = new AbortController(), { stream } = await f.model.doStream(input(parent.signal)), reader = stream.getReader();
    expect((await reader.read()).value?.type).toBe("stream-start");
    const read = reader.read(), rejected = expect(read).rejects.toThrow(/authentication timed out/);
    await flush(); expect(provider).toHaveBeenCalledTimes(2); expect(native.nextEvent).toHaveBeenCalledOnce();
    const refreshSignal = provider.mock.calls[1]![0]!.signal!;
    await vi.advanceTimersByTimeAsync(10); await rejected; reader.releaseLock();
    expect(refreshSignal.reason).toMatchObject({ code: "CURSOR_AUTH_TIMEOUT" });
    expect(native.cancel).toHaveBeenCalledOnce(); expect(native.setAccessToken).not.toHaveBeenCalled();
    expect(f.engine.remove).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    const firstScope = JSON.parse(vi.mocked(f.engine.start).mock.calls[0]![0]).scope;
    late.resolve("fixture-late"); await flush(); expect(native.setAccessToken).not.toHaveBeenCalled();
    vi.mocked(f.engine.start).mockResolvedValueOnce(handle());
    const nextModel = createNativeModel(f.config); await nextModel.doGenerate(input());
    expect(f.engine.start).toHaveBeenCalledTimes(2);
    expect(JSON.parse(vi.mocked(f.engine.start).mock.calls[1]![0]).scope).toBe(firstScope);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("also bounds a non-settling native token-application wait", async () => {
    const late = deferred<void>(), native = handle([{ type: "native-token-refresh" }, finish()]);
    vi.mocked(native.setAccessToken).mockImplementationOnce(() => late.promise);
    const provider: AccessTokenProvider = async options => options?.forceRefresh ? "fixture-new" : "fixture-initial";
    const f = fixture(native, provider), { stream } = await f.model.doStream(input()), reader = stream.getReader();
    await reader.read(); const read = reader.read(), rejected = expect(read).rejects.toThrow(/authentication timed out/);
    await flush(); expect(native.setAccessToken).toHaveBeenCalledExactlyOnceWith("fixture-new");
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(native.cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    late.resolve(); await flush(); expect(native.nextEvent).toHaveBeenCalledOnce(); reader.releaseLock();
  });
  it.each(["initial", "refresh"])("gives caller abort precedence over the %s auth deadline and cleans its listeners", async stage => {
    const late = deferred<string>(), provider: AccessTokenProvider = async options => stage === "initial" || options?.forceRefresh ? late.promise : "fixture-initial";
    const native = handle([{ type: "native-token-refresh" }]), f = fixture(native, provider), parent = new AbortController();
    if (stage === "initial") {
      const pending = f.model.doStream(input(parent.signal)), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(9); parent.abort(); await rejected;
      expect(f.engine.start).not.toHaveBeenCalled();
    } else {
      const { stream } = await f.model.doStream(input(parent.signal)), reader = stream.getReader();
      await reader.read(); const read = reader.read(), rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(9); parent.abort(); await rejected; reader.releaseLock();
    }
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    late.reject(new Error("late fixture rejection")); await flush(); expect(native.setAccessToken).not.toHaveBeenCalled();
  });
  it.each([
    [undefined, 25000], ["", 25000], ["nonsense", 25000], ["Infinity", 25000], ["0", 1], ["-1", 1], ["60000", 30000],
  ] as const)("keeps OPENCODE_CURSOR_AUTH_TIMEOUT_MS=%s finite and non-disableable (%sms)", async (value, budget) => {
    vi.stubEnv("OPENCODE_CURSOR_AUTH_TIMEOUT_MS", value);
    const f = fixture(handle(), () => new Promise<never>(() => {})), pending = f.model.doStream(input());
    const rejected = expect(pending).rejects.toThrow(/authentication timed out/);
    await vi.advanceTimersByTimeAsync(budget! - 1); expect(f.engine.start).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(vi.getTimerCount()).toBe(0); expect(f.engine.start).not.toHaveBeenCalled();
  });
});
