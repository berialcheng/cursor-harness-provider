import { afterEach, describe, expect, it, vi } from "vitest";
import { complete, streamSimple, getApiProvider } from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI, type ExtensionContext, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { registerCursorNative } from "../../packages/pi/src/index.js";
import { FakeEngine, FakeStream, fakeAuth, token, jwt, env, model as baseModel, context, finish, deferred, tick } from "./fixtures.js";
import { parameterizedCatalog } from "./catalog-fixture.js";

const hosts: Array<{ stop(): unknown }> = [];
let sequence = 0;
function host(id = `compat-parent-${++sequence}`) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const engine = new FakeEngine(), auth = fakeAuth();
  const createEngine = vi.fn(() => engine);
  const canonical = vi.fn(async () => ({ auth: { apiKey: token }, env: {} }));
  let config!: ProviderConfig;
  registerCursorNative({ registerProvider: (_id: string, value: ProviderConfig) => { config = value; },
    registerCommand: () => {}, on: (event: string, fn: (...args: any[]) => unknown) => { handlers.set(event, fn); },
  } as unknown as ExtensionAPI, { createEngine, auth: auth.auth, env: () => env });
  const ctx = { cwd: "/tmp/compat-workspace", sessionManager: { getSessionId: () => id }, modelRegistry: { getProviderAuth: canonical } } as unknown as ExtensionContext;
  const start = () => handlers.get("session_start")!({}, ctx);
  const stop = () => handlers.get("session_shutdown")!({}, ctx);
  const result = { engine, auth, createEngine, canonical, get config() { return config; }, id, ctx, start, stop };
  hosts.push(result); start(); return result;
}
afterEach(() => { for (const h of hosts.splice(0)) h.stop(); });
const payloads = (h: ReturnType<typeof host>) => h.engine.start.mock.calls.map(call => JSON.parse(call[0]));
const ownedModel = (h: ReturnType<typeof host>) => ({ ...baseModel(), ...h.config.models!.find(m => m.id === "auto") }) as Model<Api>;
const tools = () => context({ tools: [{ name: "read", description: "host permission gate only", parameters: { type: "object" } }],
  messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
const toolEvents = () => [
  { type: "tool-input-start", id: "c", toolName: "read" }, { type: "tool-input-delta", id: "c", delta: '{}' },
  { type: "tool-input-end", id: "c" }, { type: "tool-call", toolCallId: "c", toolName: "read", input: '{}' }, finish("tool-calls"),
];

describe("actual pi-ai compat facade with lifecycle-owned Cursor dispatch", () => {
  it("complete uses a host-registered model and canonical missing-key auth; one-shot scopes are cleaned", async () => {
    const h = host();
    const sdk = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
    sdk.registerProvider("cursor", h.config);
    const selected = sdk.getModel("cursor", "auto")!;
    expect((await complete(selected, context())).stopReason).toBe("stop");
    await tick();
    expect(h.canonical).toHaveBeenCalledOnce(); expect(h.auth.system).not.toHaveBeenCalled();
    expect(h.engine.start.mock.calls[0]![1]).toBe(token);
    expect(payloads(h)[0]).toMatchObject({ stateless: true, toolChoice: "none" });
    expect(h.engine.remove).toHaveBeenCalledOnce();
  });
  it("streamSimple routes exact parameterized/image metadata through the same runtime catalog", async () => {
    const h = host(); h.engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog));
    const definitions = await h.config.refreshModels!({ allowNetwork: true, signal: new AbortController().signal,
      credential: { type: "api_key", key: token }, baseUrl: env.PI_CURSOR_AGENT_URL,
      publish: async ({ update }: any) => { update?.(); return true; },
    } as any);
    const selected = { ...baseModel(), ...definitions.find(m => m.id === "family-1m-max-mode-high-thinking-fast") } as Model<Api>;
    expect(selected.id).toBe("family-1m-max-mode-high-thinking-fast");
    const image = context({ messages: [{ role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 1 }] });
    const s = streamSimple(selected, image, { reasoning: "high" });
    const events = []; for await (const e of s) events.push(e.type);
    expect(events).toContain("text_delta"); expect((await s.result()).stopReason).toBe("stop");
    expect(payloads(h)[0]).toMatchObject({ modelId: "family", maxMode: true, modelParameters: expect.arrayContaining([{ id: "reasoning", value: "high" }]) });
    expect(payloads(h)[0].prompt[0].content[0].type).toBe("file");
  });
  it("fails ambiguous owners before either canonical auth or native I/O, but accepts exact parent identity", async () => {
    const a = host(), b = host();
    await expect(complete(baseModel(), context(), { apiKey: token })).rejects.toThrow(/ambiguous/);
    expect(a.canonical).not.toHaveBeenCalled(); expect(b.canonical).not.toHaveBeenCalled();
    expect(a.createEngine).not.toHaveBeenCalled(); expect(b.createEngine).not.toHaveBeenCalled();
    expect((await complete(baseModel(), context(), { sessionId: a.id })).stopReason).toBe("stop");
    expect(a.engine.start).toHaveBeenCalledOnce(); expect(b.engine.start).not.toHaveBeenCalled();
  });
  it("duplicate exact identities are ambiguous too", async () => {
    const a = host(), b = host(a.id);
    await expect(complete(baseModel(), context(), { sessionId: a.id })).rejects.toThrow(/ambiguous/);
    expect(a.canonical).not.toHaveBeenCalled(); expect(b.canonical).not.toHaveBeenCalled();
  });
  it("keeps new API installed with no owners and never overrides the legacy API", async () => {
    const legacy = getApiProvider("cursor-native"); const h = host(); h.stop();
    await expect(complete(baseModel(), context())).rejects.toThrow(/no active/);
    expect(getApiProvider("cursor-native")).toBe(legacy);
  });
  it("does not route a known stale parent's request to another unique active owner", async () => {
    const a = host(); a.stop(); const b = host();
    await expect(complete(baseModel(), context(), { sessionId: a.id })).rejects.toThrow(/stale/);
    expect(b.canonical).not.toHaveBeenCalled(); expect(b.createEngine).not.toHaveBeenCalled();
  });
  it("aborted calls never resolve credentials or create native engines", async () => {
    const h = host(); const controller = new AbortController(); controller.abort();
    await expect(complete(ownedModel(h), context(), { signal: controller.signal })).rejects.toThrow();
    expect(h.canonical).not.toHaveBeenCalled(); expect(h.createEngine).not.toHaveBeenCalled();
  });
  it("canonical rejection cannot fall back to OS credentials", async () => {
    const h = host(); h.canonical.mockRejectedValue(new Error("fixture canonical rejection"));
    expect((await complete(ownedModel(h), context())).errorMessage).toContain("canonical rejection");
    expect(h.auth.system).not.toHaveBeenCalled(); expect(h.createEngine).not.toHaveBeenCalled();
  });
  it("explicit account mismatch is rejected before native work", async () => {
    const h = host();
    expect((await complete(ownedModel(h), context(), { apiKey: jwt("different-account") })).errorMessage).toMatch(/account does not match/);
    expect(h.auth.system).not.toHaveBeenCalled(); expect(h.createEngine).not.toHaveBeenCalled();
  });
  it("rejected explicit tokens never switch account or fall back after native refresh", async () => {
    const h = host(); h.engine.streams.push(new FakeStream([{ type: "native-token-refresh" }]));
    const result = await complete(ownedModel(h), context(), { apiKey: token, sessionId: h.id });
    expect(result.errorMessage).toMatch(/same rejected/); expect(h.auth.system).not.toHaveBeenCalled();
    expect(h.engine.remove).not.toHaveBeenCalled();
  });
  it("same-account canonical refresh updates only the selected live stream", async () => {
    const h = host(); const rotated = jwt("fixture-a", "rotated");
    h.canonical.mockResolvedValueOnce({ auth: { apiKey: token }, env: {} }).mockResolvedValue({ auth: { apiKey: rotated }, env: {} });
    const native = new FakeStream([{ type: "native-token-refresh" }, ...new FakeStream().events]);
    h.engine.streams.push(native);
    expect((await complete(ownedModel(h), context(), { apiKey: token, sessionId: h.id })).stopReason).toBe("stop");
    expect(native.setAccessToken).toHaveBeenCalledWith(rotated); expect(h.auth.system).not.toHaveBeenCalled();
  });
  it("canonical refresh account changes are rejected rather than switching accounts", async () => {
    const h = host();
    h.canonical.mockResolvedValueOnce({ auth: { apiKey: token }, env: {} }).mockResolvedValue({ auth: { apiKey: jwt("other-account") }, env: {} });
    const native = new FakeStream([{ type: "native-token-refresh" }]); h.engine.streams.push(native);
    expect((await complete(ownedModel(h), context(), { apiKey: token, sessionId: h.id })).errorMessage).toMatch(/account changed/);
    expect(native.setAccessToken).not.toHaveBeenCalled(); expect(h.auth.system).not.toHaveBeenCalled(); expect(h.engine.remove).not.toHaveBeenCalled();
  });
  it("late auth completion after shutdown/reload cannot start or rebind the replacement engine", async () => {
    const h = host(); const wait = deferred<{ auth: { apiKey: string }; env: {} }>();
    h.canonical.mockReturnValueOnce(wait.promise);
    const pending = complete(ownedModel(h), context(), { sessionId: h.id });
    await tick(); h.stop(); h.start(); wait.resolve({ auth: { apiKey: token }, env: {} });
    expect((await pending).stopReason).toBe("aborted"); expect(h.createEngine).not.toHaveBeenCalled();
    expect((await complete(ownedModel(h), context(), { sessionId: h.id })).stopReason).toBe("stop");
  });
  it("main, host child, compat stable and one-shot checkpoint scopes never coincide", async () => {
    const h = host();
    await h.config.streamSimple!(ownedModel(h), context(), { apiKey: token, sessionId: h.id }).result();
    await h.config.streamSimple!(ownedModel(h), context(), { apiKey: token, sessionId: "aux-child" }).result();
    await complete(ownedModel(h), context(), { sessionId: h.id });
    await complete(ownedModel(h), context()); await complete(ownedModel(h), context());
    const requests = payloads(h); expect(new Set(requests.map(p => p.scope)).size).toBe(5);
    expect(requests.map(p => p.stateless)).toEqual([false, false, false, true, true]);
  });
  it("stable compat IDs continue tools without any native tool execution, isolated from main and replacement owners", async () => {
    const h = host(); h.engine.streams.push(new FakeStream(toolEvents()));
    const first = await complete(ownedModel(h), tools(), { sessionId: h.id });
    expect(first.stopReason).toBe("toolUse");
    await complete(ownedModel(h), context({ messages: [{ role: "user", content: "fixture", timestamp: 1 }, first,
      { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "host-authorized result" }], isError: false, timestamp: 2 }] }), { sessionId: h.id });
    expect(payloads(h)[0].scope).toBe(payloads(h)[1].scope); expect(h.engine.remove).not.toHaveBeenCalled();
    const before = payloads(h)[0].scope; h.stop(); h.start();
    await complete(ownedModel(h), context(), { sessionId: h.id });
    expect(payloads(h)[2].scope).not.toBe(before);
  });
  it("without stable ID, tools are disabled and malicious tool output fails without erasing the fence", async () => {
    const h = host(); h.engine.streams.push(new FakeStream(toolEvents()));
    expect((await complete(ownedModel(h), tools())).stopReason).toBe("error");
    expect(payloads(h)[0]).toMatchObject({ stateless: true, toolChoice: "none" });
    expect(h.engine.remove).not.toHaveBeenCalled();
  });
  it("a payload hook cannot enable stateless compat tools", async () => {
    const h = host();
    const result = await complete(ownedModel(h), tools(), { onPayload: payload => ({ ...(payload as object), toolChoice: "auto" }) });
    expect(result.errorMessage).toMatch(/stable sessionId/); expect(h.createEngine).not.toHaveBeenCalled();
  });
  it("partial output failure never automatically removes a compat scope", async () => {
    const h = host(); h.engine.streams.push(new FakeStream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "partial" }]));
    expect((await complete(ownedModel(h), context())).stopReason).toBe("error");
    expect(h.engine.remove).not.toHaveBeenCalled();
  });
});
