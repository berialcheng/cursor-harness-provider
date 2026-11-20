import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { DeadlineError } from "@cursor-harness-provider/native/lifecycle";
import { accountPartition } from "../../packages/pi/src/security.js";
import { context, deferred, env, FakeStream, fakeAuth, jwt, model, setup, textEvents, token } from "./fixtures.js";

const shortEnv = { ...env, PI_CURSOR_AUTH_TIMEOUT_MS: "10" };
const signal = () => new AbortController().signal;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const credentials = (): OAuthCredentials => ({ access: token, refresh: "fixture-refresh", expires: 0 });
const timeout = { name: "DeadlineError", code: "CURSOR_AUTH_TIMEOUT", message: expect.stringContaining("authentication timed out") };

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Pi auth deadlines (injected credentials only)", () => {
  it("bounds external initial resolution, ignores its late account, and leaves new bindings unaffected", async () => {
    const late = deferred<{ accessToken: string; source: string } | undefined>(), { auth, system, oauth } = fakeAuth(), parent = new AbortController();
    system.mockReturnValueOnce(late.promise);
    const pending = auth.bind(undefined, shortEnv, parent.signal), rejected = expect(pending).rejects.toMatchObject(timeout);
    const bounded = system.mock.calls[0]![1]; expect(bounded).not.toBe(parent.signal);
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(bounded.reason).toBeInstanceOf(DeadlineError); expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    const access = vi.fn(() => jwt("fixture-b"));
    late.resolve({ get accessToken() { return access(); }, source: "late external fixture" }); await flush();
    expect(access).not.toHaveBeenCalled();
    system.mockResolvedValueOnce({ accessToken: token, source: "current external fixture" });
    await expect(auth.bind(undefined, shortEnv, signal())).resolves.toMatchObject({ accessToken: token, account: accountPartition(token) });
    expect(system.mock.calls.every(call => call[2] === false && call[3] === true)).toBe(true);
    expect(oauth.refresh).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("times out canonical refresh without letting a late token mutate the binding's rejected-token fence", async () => {
    const late = deferred<string>(), resolveAuth = vi.fn((_signal: AbortSignal) => late.promise), { auth, system, oauth } = fakeAuth({ resolveAuth });
    const bound = await auth.bind(token, shortEnv, signal()), parent = new AbortController();
    const pending = bound.refresh(parent.signal), rejected = expect(pending).rejects.toMatchObject(timeout);
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(resolveAuth.mock.calls[0]![0].reason).toMatchObject({ code: "CURSOR_AUTH_TIMEOUT" });
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    const renewed = jwt("fixture-a", "renewed"); late.resolve(renewed); await flush();
    // If the expired continuation updated currentToken, this legitimate refresh
    // would incorrectly reject the same returned token as already rejected.
    resolveAuth.mockResolvedValueOnce(renewed);
    await expect(bound.refresh(signal())).resolves.toBe(renewed);
    resolveAuth.mockResolvedValueOnce(renewed);
    await expect(bound.refresh(signal())).rejects.toThrow(/same rejected/);
    resolveAuth.mockResolvedValueOnce(jwt("fixture-b"));
    await expect(bound.refresh(signal())).rejects.toThrow(/account changed/);
    expect(bound.account).toBe(accountPartition(token)); expect(bound.accessToken).toBe(token);
    expect(system).not.toHaveBeenCalled(); expect(oauth.refresh).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds external-owner refresh without rotation or late token/account inspection", async () => {
    const { auth, system, oauth } = fakeAuth(), late = deferred<{ accessToken: string; source: string } | undefined>();
    system.mockResolvedValueOnce({ accessToken: token, source: "fixture external owner" }).mockReturnValueOnce(late.promise);
    const bound = await auth.bind(undefined, shortEnv, signal()), pending = bound.refresh(signal());
    const rejected = expect(pending).rejects.toMatchObject(timeout);
    await vi.advanceTimersByTimeAsync(10); await rejected;
    const access = vi.fn(() => jwt("fixture-b"));
    late.resolve({ get accessToken() { return access(); }, source: "late external fixture" }); await flush();
    expect(access).not.toHaveBeenCalled();
    const changed = jwt("fixture-a", "externally-renewed"); system.mockResolvedValueOnce({ accessToken: changed, source: "fixture external owner" });
    await expect(bound.refresh(signal())).resolves.toBe(changed);
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(system.mock.calls.every(call => call[2] === false && call[3] === true)).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])("bounds raw stored-credential refresh (system=%s) and never returns or inspects a late rotated pair", async imported => {
    const { auth, oauth, system } = fakeAuth(), latePair = deferred<OAuthCredentials>(), lateSystem = deferred<{ accessToken: string; source: string } | undefined>();
    const pair = { ...credentials(), ...(imported ? { cursorNativeSystem: true, refresh: "" } : {}) }, parent = new AbortController();
    if (imported) system.mockReturnValueOnce(lateSystem.promise); else oauth.refresh.mockReturnValueOnce(latePair.promise);
    const authEnv = { ...shortEnv, PI_CURSOR_SYSTEM_CREDENTIALS: "1" }, pending = auth.refreshCredential(pair, parent.signal, authEnv);
    const rejected = expect(pending).rejects.toMatchObject(timeout);
    const bounded = imported ? system.mock.calls[0]![1] : oauth.refresh.mock.calls[0]![1];
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(bounded.reason).toMatchObject({ code: "CURSOR_AUTH_TIMEOUT" });
    const access = vi.fn(() => jwt("fixture-b", "late-account"));
    if (imported) lateSystem.resolve({ get accessToken() { return access(); }, source: "late fixture" });
    else latePair.resolve({ get access() { return access(); }, refresh: "late-rotated", expires: 4102444800000 });
    await flush(); expect(access).not.toHaveBeenCalled();
    expect(pair.access).toBe(token); expect(pair.refresh).toBe(imported ? "" : "fixture-refresh");
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    if (imported) {
      system.mockResolvedValueOnce({ accessToken: jwt("fixture-a", "current"), source: "current fixture" });
      expect((await auth.refreshCredential(pair, signal(), authEnv)).access).toBe(jwt("fixture-a", "current"));
      expect(oauth.refresh).not.toHaveBeenCalled();
    } else {
      expect((await auth.refreshCredential(pair, signal(), authEnv)).refresh).toBe("fixture-rotated");
      expect(system).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["bind", "refresh", "raw-refresh"])("lets caller abort beat the %s timeout and tears down cancellation/timers", async entry => {
    const never = new Promise<never>(() => {}), resolveAuth = vi.fn((_signal: AbortSignal) => never);
    const { auth, system, oauth } = fakeAuth({ resolveAuth }), parent = new AbortController(), reason = new DOMException("Fixture user abort", "AbortError");
    system.mockReturnValue(never); oauth.refresh.mockReturnValue(never);
    const bound = await auth.bind(token, shortEnv, signal());
    const pending = entry === "bind" ? auth.bind(undefined, shortEnv, parent.signal)
      : entry === "refresh" ? bound.refresh(parent.signal) : auth.refreshCredential(credentials(), parent.signal, shortEnv);
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(9); parent.abort(reason); await rejected;
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    const bounded = entry === "bind" ? system.mock.calls[0]![1] : entry === "refresh" ? resolveAuth.mock.calls[0]![0] : oauth.refresh.mock.calls[0]![1];
    expect(bounded.reason).toBe(reason);
  });
  it("does not invoke any auth source after pre-existing abort, even with a zero configured budget", async () => {
    const resolveAuth = vi.fn(async (_signal: AbortSignal) => token), { auth, oauth, system } = fakeAuth({ resolveAuth });
    const bound = await auth.bind(token, shortEnv, signal()), parent = new AbortController(), reason = new Error("fixture aborted"); parent.abort(reason);
    const zeroEnv = { ...shortEnv, PI_CURSOR_AUTH_TIMEOUT_MS: "0" };
    await expect(auth.bind(undefined, zeroEnv, parent.signal)).rejects.toBe(reason);
    await expect(bound.refresh(parent.signal)).rejects.toBe(reason);
    await expect(auth.refreshCredential(credentials(), parent.signal, zeroEnv)).rejects.toBe(reason);
    expect(resolveAuth).not.toHaveBeenCalled(); expect(oauth.refresh).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
  it("does not harvest system credentials or shadow-rotate after an explicit canonical rejection or timeout", async () => {
    const resolveAuth = vi.fn(async (_signal: AbortSignal): Promise<string | undefined> => { throw new Error("fixture host rejected auth"); });
    const { auth, oauth, system } = fakeAuth({ resolveAuth }), bound = await auth.bind(token, shortEnv, signal());
    await expect(bound.refresh(signal())).rejects.toThrow("fixture host rejected auth");
    resolveAuth.mockImplementationOnce(() => new Promise<never>(() => {}));
    const pending = bound.refresh(signal()), rejected = expect(pending).rejects.toMatchObject(timeout);
    await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(system).not.toHaveBeenCalled(); expect(oauth.refresh).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    [undefined, 25000], ["", 25000], ["nonsense", 25000], ["Infinity", 25000], ["0", 1], ["-1", 1], ["60000", 30000],
  ] as const)("keeps PI_CURSOR_AUTH_TIMEOUT_MS=%s finite and non-disableable (%sms)", async (value, budget) => {
    const { auth, system } = fakeAuth(); system.mockReturnValueOnce(new Promise<never>(() => {}));
    const pending = auth.bind(undefined, { ...env, PI_CURSOR_AUTH_TIMEOUT_MS: value }, signal());
    const rejected = expect(pending).rejects.toMatchObject(timeout);
    await vi.advanceTimersByTimeAsync(budget! - 1); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(vi.getTimerCount()).toBe(0);
  });
  it("does not deadline human method selection or the browser login/poll flow", async () => {
    const { auth, oauth, system } = fakeAuth(), selection = deferred<string | undefined>(), login = deferred<OAuthCredentials>(), parent = new AbortController();
    const callbacks: OAuthLoginCallbacks = { onAuth: vi.fn(), onDeviceCode: vi.fn(), onPrompt: vi.fn(async () => ""), onSelect: () => selection.promise, signal: parent.signal };
    oauth.login.mockReturnValueOnce(login.promise);
    const pending = auth.login(callbacks, { ...shortEnv, PI_CURSOR_AUTH_TIMEOUT_MS: "1" }), settled = vi.fn();
    void pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(31000); expect(settled).not.toHaveBeenCalled(); expect(oauth.login).not.toHaveBeenCalled();
    selection.resolve("browser"); await flush(); expect(oauth.login).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31000); expect(settled).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    const pair = { ...credentials(), expires: 4102444800000 }; login.resolve(pair); await expect(pending).resolves.toEqual(pair);
    expect(system).not.toHaveBeenCalled(); expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
});

describe("Pi native refresh lifecycle (fixture runtime only)", () => {
  it("ends a never-settling refresh despite a queued native error; late auth cannot set a token or change a later account", async () => {
    const late = deferred<string>(), resolveAuth = vi.fn((_signal: AbortSignal): Promise<string | undefined> => late.promise);
    const f = setup([{ type: "native-token-refresh" }, { type: "error", error: "queued fixture native error" }], { resolveAuth, env: () => shortEnv });
    const native = f.engine.streams[0] as FakeStream, parent = new AbortController();
    try {
      const pending = f.runtime.streamSimple(model(), context(), { apiKey: token, signal: parent.signal, sessionId: "session-a" }).result();
      await flush(); expect(resolveAuth).toHaveBeenCalledOnce(); expect(native.nextEvent).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("authentication timed out") });
      expect(native.setAccessToken).not.toHaveBeenCalled(); expect(native.cancel).toHaveBeenCalledOnce();
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0); expect(f.runtime.doctor()).toContain("activeRequests=0");
      expect(vi.getTimerCount()).toBe(0);
      late.resolve(jwt("fixture-a", "late")); await flush(); expect(native.setAccessToken).not.toHaveBeenCalled();
      const next = new FakeStream([{ type: "native-token-refresh" }, ...textEvents()]), nextToken = jwt("fixture-b", "new");
      resolveAuth.mockResolvedValueOnce(nextToken); f.engine.streams.push(next);
      const result = await f.runtime.streamSimple(model(), context(), { apiKey: jwt("fixture-b"), sessionId: "session-a" }).result();
      expect(result.stopReason).toBe("stop"); expect(f.engine.start.mock.calls.at(-1)![1]).toBe(jwt("fixture-b"));
      expect(next.setAccessToken).toHaveBeenCalledExactlyOnceWith(nextToken); expect(native.setAccessToken).not.toHaveBeenCalled();
      expect(f.oauth.refresh).not.toHaveBeenCalled(); expect(f.system).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { f.runtime.shutdown(); }
  });
  it("cleans a timed-out initial external lookup without starting the engine or poisoning a subsequent request", async () => {
    const f = setup(undefined, { env: () => shortEnv }), late = deferred<{ accessToken: string; source: string } | undefined>();
    f.system.mockReturnValueOnce(late.promise);
    try {
      const pending = f.runtime.streamSimple(model(), context()).result();
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("authentication timed out") });
      expect(f.createEngine).not.toHaveBeenCalled(); expect(f.engine.start).not.toHaveBeenCalled();
      expect(f.runtime.doctor()).toContain("activeRequests=0"); expect(vi.getTimerCount()).toBe(0);
      late.resolve({ accessToken: jwt("fixture-a", "late"), source: "late fixture" }); await flush(); expect(f.engine.start).not.toHaveBeenCalled();
      const result = await f.runtime.streamSimple(model(), context(), { apiKey: jwt("fixture-b") }).result();
      expect(result.stopReason).toBe("stop"); expect(f.engine.start).toHaveBeenCalledOnce(); expect(f.engine.start.mock.calls[0]![1]).toBe(jwt("fixture-b"));
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.runtime.shutdown(); }
  });
  it("publishes caller abort, not timeout, while native refresh ignores cancellation", async () => {
    const late = deferred<string>(), resolveAuth = vi.fn((_signal: AbortSignal): Promise<string | undefined> => late.promise);
    const f = setup([{ type: "native-token-refresh" }], { resolveAuth, env: () => shortEnv }), native = f.engine.streams[0] as FakeStream;
    const parent = new AbortController();
    try {
      const pending = f.runtime.streamSimple(model(), context(), { apiKey: token, signal: parent.signal }).result();
      await vi.advanceTimersByTimeAsync(9); expect(resolveAuth).toHaveBeenCalledOnce(); parent.abort();
      expect((await pending).stopReason).toBe("aborted");
      late.reject(new Error("late fixture auth failure")); await flush();
      expect(native.setAccessToken).not.toHaveBeenCalled(); expect(native.cancel).toHaveBeenCalledOnce();
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
      expect(f.runtime.doctor()).toContain("activeRequests=0");
    } finally { f.runtime.shutdown(); }
  });
});
