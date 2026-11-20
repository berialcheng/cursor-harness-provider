import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore, type OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CursorAuth } from "../../packages/pi/src/auth/index.js";
import { createOAuthClient, tokenExpiry } from "../../packages/pi/src/auth/oauth.js";
import { createSystemResolver, systemCredentialsAllowed, windowsUsernameFromEnv } from "../../packages/pi/src/auth/system.js";
import { collect, context, deferred, env, FakeStream, fakeAuth, jwt, model, setup, textEvents, tick, token } from "./fixtures.js";

function callbacks(signal?: AbortSignal): OAuthLoginCallbacks {
  return { onAuth: vi.fn(), onDeviceCode: vi.fn(), onPrompt: vi.fn(), onSelect: vi.fn(async () => "browser"), signal };
}
describe("OAuth and credential boundaries (fixtures only)", () => {
  it("runs lazy PKCE polling, passes cancellation to HTTP, and preserves rotating refresh tokens", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(Response.json({ accessToken: token, refreshToken: "fixture-refresh" }))
      .mockResolvedValueOnce(Response.json({ accessToken: jwt("fixture-a", "new"), refreshToken: "fixture-rotated" }));
    const sleep = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => {}), auth = createOAuthClient({ fetch, sleep, pkce: () => ({ verifier: "fixture-verifier", challenge: "fixture-challenge", uuid: "fixture-uuid" }) });
    expect(fetch).not.toHaveBeenCalled();
    const cb = callbacks(new AbortController().signal), pair = await auth.login(cb);
    expect(pair).toMatchObject({ access: token, refresh: "fixture-refresh" });
    expect(cb.onAuth).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("challenge=fixture-challenge") }));
    expect((cb.onAuth as ReturnType<typeof vi.fn>).mock.calls[0]![0].url).not.toContain("verifier");
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1000, 1200]);
    expect(fetch.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    expect((await auth.refresh(pair.refresh, new AbortController().signal)).refresh).toBe("fixture-rotated");
    expect(fetch.mock.calls[2]![1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer fixture-refresh" } });
  });
  it("browser signup cancellation stops polling immediately, even if a dependency ignores the signal", async () => {
    const abort = new AbortController(), fetch = vi.fn<typeof globalThis.fetch>(), sleeping = deferred<void>();
    const client = createOAuthClient({ fetch, sleep: () => sleeping.promise });
    const cb = callbacks(abort.signal), pending = client.login(cb); await tick(); abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(fetch).not.toHaveBeenCalled();
    sleeping.resolve(); await tick(); expect(fetch).not.toHaveBeenCalled();
  });
  it("cancelled login-method selection does not look up credentials or open a browser", async () => {
    const { auth, system, oauth } = fakeAuth(), cb = callbacks(); cb.onSelect = vi.fn(async () => undefined);
    await expect(auth.login(cb, env)).rejects.toMatchObject({ name: "AbortError" });
    expect(system).not.toHaveBeenCalled(); expect(oauth.login).not.toHaveBeenCalled(); expect(cb.onAuth).not.toHaveBeenCalled();
  });
  it("keeps system consent/env opt-out failclosed and permits explicit env token without scraping", async () => {
    const { oauth } = fakeAuth(), keychain = vi.fn(async () => ({ accessToken: token })), ide = vi.fn(async () => ({}));
    const resolver = createSystemResolver(oauth, { keychain, ide });
    for (const policy of ["0", "off", "false", "deny", "unknown"]) {
      expect(systemCredentialsAllowed(policy)).toBe(false);
      expect(await resolver({ PI_CURSOR_SYSTEM_CREDENTIALS: policy }, new AbortController().signal)).toBeUndefined();
    }
    expect(await resolver({ PI_CURSOR_SYSTEM_CREDENTIALS: "0", CURSOR_ACCESS_TOKEN: "fixture-env" }, new AbortController().signal)).toMatchObject({ accessToken: "fixture-env" });
    expect(keychain).not.toHaveBeenCalled(); expect(ide).not.toHaveBeenCalled();
    expect(systemCredentialsAllowed(undefined)).toBe(true); expect(systemCredentialsAllowed(" allow ")).toBe(true);
  });
  it("imports the actual access-token expiry, not a TTL equal to Pi's five-minute refresh margin", async () => {
    const { auth, system, oauth } = fakeAuth(); system.mockResolvedValue({ accessToken: token, source: "fixture OS" });
    const cb = callbacks(); cb.onSelect = vi.fn(async () => "system");
    const imported = await auth.login(cb, { PI_CURSOR_SYSTEM_CREDENTIALS: "1" });
    expect(imported).toMatchObject({ refresh: "", cursorNativeSystem: true, expires: 4102444800000 });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("cursor", async () => ({ ...imported, type: "oauth" }));
    const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("cursor", { api: "cursor-native-rust", baseUrl: "https://fixture.invalid", models: [], oauth: {
      name: "Fixture", login: c => auth.login(c, { PI_CURSOR_SYSTEM_CREDENTIALS: "1" }),
      refreshToken: (c, s) => auth.refreshCredential(c, s, { PI_CURSOR_SYSTEM_CREDENTIALS: "1" }), getApiKey: c => auth.remember(c),
    } });
    await Promise.all(Array.from({ length: 4 }, () => runtime.getAuth("cursor")));
    expect(system).toHaveBeenCalledOnce(); expect(oauth.refresh).not.toHaveBeenCalled();
    // Even expired imports are re-read through Pi's serialized credential transaction.
    await credentials.modify("cursor", async c => ({ ...c!, expires: 0 }));
    system.mockClear();
    await Promise.all(Array.from({ length: 4 }, () => runtime.getAuth("cursor")));
    expect(system).toHaveBeenCalledOnce(); expect(oauth.refresh).not.toHaveBeenCalled();
    expect(system.mock.calls[0]?.slice(2)).toEqual([false, true]); // access-only, no forceRefresh/shadow OS rotation
  });
  it("rejects a near-expiry imported token and respects system opt-out on stored imports", async () => {
    const { auth, system, oauth } = fakeAuth();
    const near = "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify({ sub: "fixture-a", exp: Math.floor(Date.now() / 1000) + 240 })).toString("base64url") + ".fixture";
    system.mockResolvedValue({ accessToken: near, source: "fixture OS" });
    const cb = callbacks(); cb.onSelect = vi.fn(async () => "system");
    await expect(auth.login(cb, { PI_CURSOR_SYSTEM_CREDENTIALS: "1" })).rejects.toThrow(/expires too soon/);
    system.mockClear();
    await expect(auth.refreshCredential({ access: token, refresh: "", expires: 0, cursorNativeSystem: true }, new AbortController().signal, { PI_CURSOR_SYSTEM_CREDENTIALS: "0" })).rejects.toThrow(/disabled/);
    expect(system).not.toHaveBeenCalled(); expect(oauth.refresh).not.toHaveBeenCalled();
  });
  it("reads only injected sources, preferring any usable local token before stale-token refresh", async () => {
    const { oauth } = fakeAuth(), keychain = vi.fn(async () => ({ refreshToken: "stale-cli" })), ide = vi.fn(async () => ({ accessToken: token }));
    const resolver = createSystemResolver(oauth, { keychain, ide });
    expect(await resolver({ PI_CURSOR_SYSTEM_CREDENTIALS: "1" }, new AbortController().signal)).toMatchObject({ accessToken: token, source: expect.stringContaining("IDE") });
    expect(oauth.refresh).not.toHaveBeenCalled(); expect(keychain).toHaveBeenCalledOnce(); expect(ide).toHaveBeenCalledOnce();
    expect(windowsUsernameFromEnv({ USERPROFILE: "C:\\Users\\fixture" })).toBe("fixture");
    expect(windowsUsernameFromEnv({ USERNAME: "../sibling" })).toBeUndefined();
  });
  it("does not shadow-rotate an expired CLI/IDE pair when Pi imports or rechecks system credentials", async () => {
    const { oauth } = fakeAuth();
    const resolver = createSystemResolver(oauth, { keychain: async () => ({ refreshToken: "OS-owned-refresh" }), ide: async () => ({}) });
    const auth = new CursorAuth({ oauth, system: resolver });
    const cb = callbacks(); cb.onSelect = vi.fn(async () => "system");
    await expect(auth.login(cb, { PI_CURSOR_SYSTEM_CREDENTIALS: "1" })).rejects.toThrow(/No permitted/);
    await expect(auth.refreshCredential({ access: token, refresh: "", expires: 0, cursorNativeSystem: true }, new AbortController().signal, { PI_CURSOR_SYSTEM_CREDENTIALS: "1" })).rejects.toThrow(/cannot refresh/);
    expect(oauth.refresh).not.toHaveBeenCalled();
  });
  it("never rotates an external refresh pair, including legacy binding and rejected-token refresh", async () => {
    const { oauth } = fakeAuth();
    const pair = async () => ({ refreshToken: "OS-owned-refresh" });
    const resolver = createSystemResolver(oauth, { keychain: pair, ide: pair });
    const auth = new CursorAuth({ oauth, system: resolver });
    const signal = new AbortController().signal;
    await expect(auth.bind(undefined, {}, signal)).rejects.toThrow(/No Cursor access token/);
    await expect(resolver({}, signal, true, false)).resolves.toBeUndefined();
    let current = token;
    const readOnly = createSystemResolver(oauth, { keychain: async () => ({ accessToken: current, refreshToken: "OS-owned-refresh" }), ide: async () => ({}) });
    const bound = await new CursorAuth({ oauth, system: readOnly }).bind(undefined, {}, signal);
    await expect(bound.refresh(signal)).rejects.toThrow(/same rejected/);
    current = jwt("fixture-a", "renewed-by-external-owner");
    await expect(bound.refresh(signal)).resolves.toBe(current);
    expect(oauth.refresh).not.toHaveBeenCalled();
  });
  it("does not leak raw failed OAuth response bodies", async () => {
    const client = createOAuthClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("Bearer fixture-sensitive-payload", { status: 401 })) });
    await expect(client.refresh("fixture-refresh", new AbortController().signal)).rejects.toThrow(/^Cursor OAuth refresh failed \(HTTP 401\)/);
    expect(tokenExpiry("opaque", 100)).toBe(3600100);
  });
  it("keeps the host OAuth callback raw, returning rotating pairs under Pi's storage transaction", async () => {
    const { auth, oauth, system } = fakeAuth(), signal = new AbortController().signal;
    const pair = await auth.refreshCredential({ access: token, refresh: "fixture-refresh", expires: 0 }, signal, env);
    expect(oauth.refresh).toHaveBeenCalledExactlyOnceWith("fixture-refresh", expect.any(AbortSignal));
    expect(oauth.refresh.mock.calls[0]![1].aborted).toBe(false);
    expect(pair).toMatchObject({ access: jwt("fixture-a", "two"), refresh: "fixture-rotated" });
    expect(system).not.toHaveBeenCalled();
  });
  it("uses host-canonical resolution for native-token-refresh and accepts a changed token for the pinned account", async () => {
    const resolveAuth = vi.fn(async (_signal: AbortSignal) => jwt("fixture-a", "host-refreshed"));
    const { runtime, engine, auth, oauth, system } = setup([{ type: "native-token-refresh" }, ...textEvents()], { resolveAuth });
    auth.remember({ access: token, refresh: "fixture-refresh", expires: 4102444800000 });
    const handle = engine.streams[0] as FakeStream;
    const result = await runtime.streamSimple(model(), context(), { apiKey: token, sessionId: "session-a" }).result();
    expect(result.stopReason).toBe("stop"); expect(resolveAuth).toHaveBeenCalledOnce();
    expect(resolveAuth.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(handle.setAccessToken).toHaveBeenCalledWith(jwt("fixture-a", "host-refreshed"));
    expect(oauth.refresh).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it.each([token, undefined])("a cached rejected/unavailable host token requires /login, never direct OAuth rotation", async resolved => {
    const resolveAuth = vi.fn(async (_signal: AbortSignal) => resolved);
    const { runtime, engine, auth, oauth, system } = setup([{ type: "native-token-refresh" }], { resolveAuth });
    auth.remember({ access: token, refresh: "fixture-refresh", expires: 4102444800000 });
    const handle = engine.streams[0] as FakeStream;
    const result = await runtime.streamSimple(model(), context(), { apiKey: token }).result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("/login cursor") });
    if (resolved) expect(result.errorMessage).toMatch(/same rejected/);
    expect(resolveAuth).toHaveBeenCalledOnce(); expect(oauth.refresh).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled();
    expect(handle.setAccessToken).not.toHaveBeenCalled(); expect(handle.cancel).toHaveBeenCalledOnce(); runtime.shutdown();
  });
  it("rejects a repeated rejected token even after an earlier canonical refresh changed the original token", async () => {
    const changed = jwt("fixture-a", "new"), resolveAuth = vi.fn(async () => changed);
    const { runtime, engine, oauth, system } = setup([{ type: "native-token-refresh" }, { type: "native-token-refresh" }], { resolveAuth });
    const handle = engine.streams[0] as FakeStream;
    const result = await runtime.streamSimple(model(), context(), { apiKey: token }).result();
    expect(result.errorMessage).toMatch(/same rejected.*\/login cursor/); expect(handle.setAccessToken).toHaveBeenCalledExactlyOnceWith(changed);
    expect(resolveAuth).toHaveBeenCalledTimes(2); expect(oauth.refresh).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("refuses an account switch during native refresh and redacts the old credential", async () => {
    const resolveAuth = vi.fn(async () => jwt("fixture-b"));
    const { runtime, engine, oauth, system } = setup([{ type: "native-token-refresh" }], { resolveAuth });
    const handle = engine.streams[0] as FakeStream;
    const result = await runtime.streamSimple(model(), context(), { apiKey: token, sessionId: "session-a" }).result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("account changed") });
    expect(handle.setAccessToken).not.toHaveBeenCalled(); expect(handle.cancel).toHaveBeenCalledOnce();
    expect(oauth.refresh).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("never silently harvests a system account after an explicit Pi credential is rejected", async () => {
    const { runtime, auth, oauth, system } = setup([{ type: "native-token-refresh" }]);
    auth.remember({ access: token, refresh: "fixture-refresh", expires: 4102444800000 });
    const result = await runtime.streamSimple(model(), context(), { apiKey: token, sessionId: "session-a" }).result();
    expect(result.errorMessage).toMatch(/canonical auth resolution unavailable.*\/login cursor/);
    expect(oauth.refresh).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("cancels pending host resolution; a late callback cannot update native auth or poison a later login", async () => {
    const pending = deferred<string>(), resolveAuth = vi.fn((_signal: AbortSignal) => pending.promise);
    const { runtime, engine, auth, oauth } = setup([{ type: "native-token-refresh" }], { resolveAuth });
    const abort = new AbortController(), handle = engine.streams[0] as FakeStream;
    const stream = runtime.streamSimple(model(), context(), { apiKey: token, signal: abort.signal }); await tick();
    expect(resolveAuth).toHaveBeenCalledOnce(); abort.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    const b = { access: jwt("fixture-b"), refresh: "b-refresh", expires: 4102444800000 };
    oauth.login.mockResolvedValueOnce(b); expect(await auth.login(callbacks(), env)).toEqual(b);
    pending.resolve(jwt("fixture-a", "late")); await tick();
    const bNew = jwt("fixture-b", "new"); resolveAuth.mockResolvedValueOnce(bNew);
    const next = new FakeStream([{ type: "native-token-refresh" }, ...textEvents()]); engine.streams.push(next);
    expect((await runtime.streamSimple(model(), context(), { apiKey: b.access }).result()).stopReason).toBe("stop");
    expect(engine.start.mock.calls.at(-1)![1]).toBe(b.access); expect(next.setAccessToken).toHaveBeenCalledWith(bNew);
    expect(handle.setAccessToken).not.toHaveBeenCalled(); expect(oauth.refresh).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("public bind.refresh is safe without a canonical resolver even after remembering an OAuth pair", async () => {
    const { auth, oauth, system } = fakeAuth(); auth.remember({ access: token, refresh: "fixture-refresh", expires: 0 });
    const bound = await auth.bind(token, env, new AbortController().signal);
    await expect(bound.refresh(new AbortController().signal)).rejects.toThrow(/canonical.*\/login cursor/);
    expect(oauth.refresh).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled();
  });
  it("a late host callback for A cannot replace a subsequent explicit login to B", async () => {
    const pending = deferred<string>(), resolveAuth = vi.fn((_signal: AbortSignal) => pending.promise);
    const { auth, oauth, system } = fakeAuth({ resolveAuth });
    const bound = await auth.bind(token, env, new AbortController().signal);
    const refreshed = bound.refresh(new AbortController().signal);
    const b = { access: jwt("fixture-b"), refresh: "b-refresh", expires: 4102444800000 };
    oauth.login.mockResolvedValueOnce(b); await auth.login(callbacks(), env);
    pending.resolve(jwt("fixture-a", "late")); await expect(refreshed).resolves.toBe(jwt("fixture-a", "late"));
    resolveAuth.mockResolvedValueOnce(jwt("fixture-b", "new"));
    const bBound = await auth.bind(b.access, env, new AbortController().signal);
    await expect(bBound.refresh(new AbortController().signal)).resolves.toBe(jwt("fixture-b", "new"));
    expect(oauth.refresh).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled();
  });
});
