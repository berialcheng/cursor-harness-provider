import { afterEach, expect, it, vi } from "vitest";
import * as compat from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { registerCursorNative } from "../../packages/pi/src/index.js";
import { installCompatDispatcher, type CompatRegistry } from "../../packages/pi/src/compat.js";
import { context, env, FakeEngine, fakeAuth, model, token } from "./fixtures.js";

vi.mock("@earendil-works/pi-ai/compat", { spy: true });

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.restoreAllMocks(); });

it("installs one dispatcher into independent host and physical views with lifecycle fencing and no old API override", async () => {
  type Provider = NonNullable<ReturnType<CompatRegistry["getApiProvider"]>>;
  const entries = new Map<string, Provider>();
  const legacy = { api: "cursor-native", stream: vi.fn(), streamSimple: vi.fn() } as Provider;
  entries.set(legacy.api, legacy);
  const physicalLegacy = compat.getApiProvider("cursor-native");
  const register = vi.fn<(api: string) => void>();
  const hostRegistry: CompatRegistry = { getApiProvider: api => entries.get(api),
    registerApiProvider(provider) { register(provider.api); entries.set(provider.api, provider as unknown as Provider); } };
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const engine = new FakeEngine(), auth = fakeAuth(), createEngine = vi.fn(() => engine);
  const canonical = vi.fn(async () => ({ auth: { apiKey: token }, env: {} }));
  let config!: ProviderConfig;
  registerCursorNative({
    registerProvider: (_id: string, value: ProviderConfig) => { config = value; },
    registerCommand: () => {},
    on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler); },
  } as unknown as ExtensionAPI, { compatRegistry: hostRegistry, createEngine, auth: auth.auth, env: () => env });
  const ctx = { cwd: "/tmp/compat-loader-fixture", sessionManager: { getSessionId: () => "loader-parent" },
    modelRegistry: { getProviderAuth: canonical } } as unknown as ExtensionContext;
  const start = () => handlers.get("session_start")!({}, ctx);
  const stop = () => { handlers.get("session_shutdown")!({}, ctx); };
  stops.push(stop);
  const selected = () => ({ ...model(), ...config.models!.find(m => m.id === "auto") }) as Model<Api>;
  const physical = () => compat.getApiProvider("cursor-native-rust")!;
  const host = () => hostRegistry.getApiProvider("cursor-native-rust")!;
  expect(() => host().streamSimple(selected(), context())).toThrow(/no active/);
  expect(createEngine).not.toHaveBeenCalled();
  // Pi may flush its queued providers between the factory and session_start.
  entries.delete("cursor-native-rust");
  start();
  expect(register).toHaveBeenCalledTimes(2);
  const stale = selected();
  for (const provider of [host(), physical()]) {
    expect((await provider.streamSimple(stale, context()).result()).stopReason).toBe("stop");
  }
  expect(canonical).toHaveBeenCalledTimes(2);
  expect(auth.system).not.toHaveBeenCalled();
  stop();
  for (const provider of [host(), physical()]) expect(() => provider.streamSimple(stale, context())).toThrow(/no active/);
  start();
  for (const provider of [host(), physical()]) {
    expect(() => provider.streamSimple(stale, context(), { sessionId: "loader-parent" })).toThrow(/stale/);
    expect((await provider.streamSimple(selected(), context()).result()).stopReason).toBe("stop");
  }
  expect(register.mock.calls.every(([api]) => api === "cursor-native-rust")).toBe(true);
  expect(hostRegistry.getApiProvider("cursor-native")).toBe(legacy);
  expect(compat.getApiProvider("cursor-native")).toBe(physicalLegacy);
});

it("deduplicates identical public register functions without retaining registry instances", () => {
  const register = vi.mocked(compat.registerApiProvider); register.mockClear();
  installCompatDispatcher({ getApiProvider: compat.getApiProvider, registerApiProvider: compat.registerApiProvider });
  expect(register).toHaveBeenCalledOnce();
  expect(register.mock.calls[0]![0].api).toBe("cursor-native-rust");
});
