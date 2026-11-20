import { afterEach, expect, it, vi } from "vitest";
import { complete } from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI, type ExtensionContext, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { registerCursorNative } from "../../packages/pi/src/index.js";
import { COMPAT_OWNER_FIELD } from "../../packages/pi/src/compat.js";
import { context, env, FakeEngine, fakeAuth, jwt } from "./fixtures.js";

const owners: Array<{ stop(): void }> = [];
let sequence = 0;
async function owner(account: string) {
  const sdk = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const handlers = new Map<string, (...args: any[]) => unknown>(), engine = new FakeEngine(), auth = fakeAuth();
  const createEngine = vi.fn(() => engine), canonical = vi.fn(async () => ({ auth: { apiKey: jwt(account) }, env: {} }));
  const sessionId = `provenance-parent-${++sequence}`;
  const ctx = { cwd: "/tmp/compat-provenance-fixture", sessionManager: { getSessionId: () => sessionId }, modelRegistry: { getProviderAuth: canonical } } as unknown as ExtensionContext;
  registerCursorNative({ registerProvider: (_id: string, config: ProviderConfig) => sdk.registerProvider("cursor", config),
    registerCommand: () => {}, on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler); },
  } as unknown as ExtensionAPI, { createEngine, auth: auth.auth, env: () => env });
  const start = () => { handlers.get("session_start")!({}, ctx); };
  const stop = () => { handlers.get("session_shutdown")!({}, ctx); };
  const result = { sdk, engine, createEngine, canonical, sessionId, start, stop, selected: () => sdk.getModel("cursor", "auto")! };
  owners.push(result); start(); return result;
}
afterEach(() => { for (const o of owners.splice(0)) o.stop(); });

it("preserves model ownership through the real SDK registry and disambiguates active owners", async () => {
  const a = await owner("account-a"), b = await owner("account-b");
  const selected = a.selected();
  expect((selected as any)[COMPAT_OWNER_FIELD]).toEqual(expect.any(String));
  expect((await complete(selected, context(), { sessionId: "arbitrary-child-loop" })).stopReason).toBe("stop");
  expect(a.canonical).toHaveBeenCalledOnce(); expect(b.canonical).not.toHaveBeenCalled();
  expect(a.createEngine).toHaveBeenCalledOnce(); expect(b.createEngine).not.toHaveBeenCalled();
});
it("rejects stale models and stale child IDs before borrowing a newer unique owner's credentials", async () => {
  const a = await owner("account-a"), stale = a.selected(); a.stop();
  const b = await owner("account-b");
  for (const sessionId of [undefined, "old-child-loop"]) {
    await expect(complete(stale, context(), { sessionId })).rejects.toThrow(/stale/);
  }
  expect(b.canonical).not.toHaveBeenCalled(); expect(b.createEngine).not.toHaveBeenCalled();
});
it("rejects conflicting parent identity and requires explicit ownership for untagged models", async () => {
  const a = await owner("account-a"), b = await owner("account-b");
  await expect(complete(a.selected(), context(), { sessionId: b.sessionId })).rejects.toThrow(/do not match/);
  b.stop(); const untagged = { ...a.selected() } as any; delete untagged[COMPAT_OWNER_FIELD];
  await expect(complete(untagged, context())).rejects.toThrow(/stale or unknown/);
  expect(a.canonical).not.toHaveBeenCalled(); expect(b.canonical).not.toHaveBeenCalled();
  expect((await complete(untagged, context(), { sessionId: a.sessionId })).stopReason).toBe("stop");
});
it("rotation publishes fresh model provenance and never revives a previous owner with the same parent ID", async () => {
  const a = await owner("account-a"), stale = a.selected();
  a.stop(); a.start();
  const current = a.selected();
  expect((current as any)[COMPAT_OWNER_FIELD]).not.toBe((stale as any)[COMPAT_OWNER_FIELD]);
  await expect(complete(stale, context(), { sessionId: a.sessionId })).rejects.toThrow(/stale/);
  expect(a.canonical).not.toHaveBeenCalled(); expect(a.createEngine).not.toHaveBeenCalled();
  expect((await complete(current, context(), { sessionId: a.sessionId })).stopReason).toBe("stop");
});
it("retained child provider callbacks cannot borrow a replacement parent's runtime or stamp its owner", async () => {
  const a = await owner("account-a"), stale = a.selected();
  const retained = a.sdk.getRegisteredProviderConfig("cursor")!;
  a.stop(); a.canonical.mockResolvedValue({ auth: { apiKey: jwt("account-b") }, env: {} }); a.start();
  const failed = await retained.streamSimple!(stale, context(), { apiKey: jwt("account-a"), sessionId: "retained-child" }).result();
  expect(failed.stopReason).toBe("aborted");
  const publish = vi.fn(async () => true);
  await expect(retained.refreshModels!({ allowNetwork: false, signal: new AbortController().signal,
    credential: { type: "api_key", key: jwt("account-a") }, publish,
  } as any)).rejects.toThrow(/stale/);
  expect(publish).not.toHaveBeenCalled(); expect(a.createEngine).not.toHaveBeenCalled(); expect(a.canonical).not.toHaveBeenCalled();
  expect((a.selected() as any)[COMPAT_OWNER_FIELD]).not.toBe((stale as any)[COMPAT_OWNER_FIELD]);
});
