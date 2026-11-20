import { describe, expect, it, vi } from "vitest";
import type { ModelsPublication, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { parameterizedCatalog } from "./catalog-fixture.js";
import { context, finish, model, setup, textEvents, tick, token } from "./fixtures.js";

const options = { apiKey: token, sessionId: "session-a" };
function refreshContext(stored?: ModelsStoreEntry, allowNetwork = false) {
  let persisted = stored;
  const context: RefreshModelsContext = { credential: { type: "api_key", key: token }, stored, allowNetwork, signal: new AbortController().signal,
    publish: vi.fn(async (p: ModelsPublication) => { if (p.persist) persisted = structuredClone(p.persist); p.update?.(); return true; }) };
  return { context, get stored() { return persisted; } };
}
const toolEvents = [
  { type: "tool-input-start", id: "1", toolName: "read" }, { type: "tool-input-delta", id: "1", delta: '{"path":"fixture"}' },
  { type: "tool-input-end", id: "1" }, { type: "tool-call", toolCallId: "1", toolName: "read", input: '{"path":"fixture"}' }, finish("tool-calls"),
];
const toolContext = () => context({ tools: [{ name: "read", description: "fixture", parameters: { type: "object" } }], messages: [{ role: "user", content: "read fixture", timestamp: 1 }] });

describe("Pi reliability regressions", () => {
  it("isolates content-block and tool-call ID namespaces", async () => {
    const { runtime } = setup([...textEvents("before").slice(0, -1).map(e => ({ ...e, id: "1" })), ...toolEvents]);
    const result = await runtime.streamSimple(model(), toolContext(), options).result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([{ type: "text", text: "before" }, { type: "toolCall", id: "1", name: "read", arguments: { path: "fixture" } }]);
    runtime.shutdown();
  });
  it("retains a stable BTW-style child actor for its tool result, never sharing the parent or summary actor", async () => {
    const { runtime, engine } = setup(toolEvents);
    const childOptions = { ...options, sessionId: "btw-child" };
    const first = await runtime.streamSimple(model(), toolContext(), childOptions).result(); await tick();
    expect(first.stopReason).toBe("toolUse"); expect(engine.remove).not.toHaveBeenCalled();
    const child = JSON.parse(engine.start.mock.calls[0]![0]);
    const messages = toolContext().messages;
    const continued = context({ messages: [...messages, first, { role: "toolResult", toolCallId: "1", toolName: "read", isError: false, content: [{ type: "text", text: "fixture content" }], timestamp: 3 }] });
    expect((await runtime.streamSimple(model(), continued, childOptions).result()).stopReason).toBe("stop");
    expect(JSON.parse(engine.start.mock.calls[1]![0]).scope).toBe(child.scope);
    await runtime.streamSimple(model(), context(), options).result();
    expect(JSON.parse(engine.start.mock.calls[2]![0]).scope).not.toBe(child.scope);
    await runtime.streamSimple(model(), context(), { ...childOptions, cacheRetention: "none" }).result(); await tick();
    expect(JSON.parse(engine.start.mock.calls[3]![0])).toMatchObject({ stateless: true }); expect(engine.remove).toHaveBeenCalledOnce();
    runtime.shutdown();
  });
  it("does not let a persisted failed/malformed assistant poison a later safe host request", async () => {
    const { runtime, engine } = setup([{ type: "tool-input-start", id: "bad", toolName: "read" }, { type: "tool-input-delta", id: "bad", delta: '{"path":' }]);
    const failed = await runtime.streamSimple(model(), toolContext(), options).result();
    expect(failed.stopReason).toBe("error"); expect(failed.content[0]).toMatchObject({ type: "toolCall", argumentsError: expect.any(String) });
    const next = context({ messages: [...toolContext().messages, failed, { role: "user", content: "A safe later task", timestamp: 4 }] });
    expect((await runtime.streamSimple(model(), next, options).result()).stopReason).toBe("stop");
    const request = JSON.parse(engine.start.mock.calls[1]![0]);
    expect(JSON.stringify(request.prompt)).not.toContain('"type":"tool-call"');
    expect(JSON.stringify(request.prompt)).toContain("A safe later task"); runtime.shutdown();
  });
  it("restores non-auto and structured routes from Pi's persisted context across a fresh runtime, without native/auth work", async () => {
    const first = setup(); first.engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog));
    const online = refreshContext(undefined, true); await first.runtime.refreshModels(online.context);
    expect(online.stored!.models.some(m => m.id === "family-high")).toBe(true);
    expect(JSON.stringify(online.stored)).not.toContain(token); first.runtime.shutdown();
    const second = setup(), offline = refreshContext(online.stored);
    expect((await second.runtime.refreshModels(offline.context)).map(m => m.id)).toContain("family-high");
    expect(second.createEngine).not.toHaveBeenCalled(); expect(second.system).not.toHaveBeenCalled();
    expect((await second.runtime.streamSimple(model("family"), context(), { ...options, reasoning: "high" }).result()).stopReason).toBe("stop");
    expect(JSON.parse(second.engine.start.mock.calls[0]![0])).toMatchObject({ modelId: "family", maxMode: false,
      modelParameters: parameterizedCatalog[0]!.parameterized!.variants[1]!.parameters });
    second.runtime.shutdown();
  });
  it("does not accept stale generation publications or restore a different account/endpoint", async () => {
    const first = setup(); first.engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog));
    const online = refreshContext(undefined, true); await first.runtime.refreshModels(online.context); first.runtime.shutdown();
    const second = setup(), offline = refreshContext(online.stored);
    offline.context.publish = vi.fn(async () => false);
    expect((await second.runtime.refreshModels(offline.context)).map(m => m.id)).toEqual(["auto"]);
    const changed = refreshContext(online.stored); changed.context.credential = { type: "api_key", key: "different-fixture-account" };
    expect((await second.runtime.refreshModels(changed.context)).map(m => m.id)).toEqual(["auto"]);
    const remote = setup(undefined, { env: () => ({ PI_CURSOR_SYSTEM_CREDENTIALS: "0", PI_CURSOR_AGENT_URL: "http://127.0.0.1:10" }) });
    expect((await remote.runtime.refreshModels(refreshContext(online.stored).context)).map(m => m.id)).toEqual(["auto"]);
    expect(second.createEngine).not.toHaveBeenCalled(); second.runtime.shutdown(); remote.runtime.shutdown();
  });
  it("keeps scope stable if discovery reorders an advertised parameter set", async () => {
    const { runtime, engine } = setup(); engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await runtime.discover(token);
    await runtime.streamSimple(model("family"), context(), { ...options, reasoning: "high" }).result();
    const before = JSON.parse(engine.start.mock.calls.at(-1)![0]);
    const reordered = structuredClone(parameterizedCatalog);
    for (const v of reordered[0]!.parameterized!.variants) v.parameters.reverse();
    engine.listModels.mockResolvedValue(JSON.stringify(reordered)); await runtime.discover(token);
    await runtime.streamSimple(model("family"), context(), { ...options, reasoning: "high" }).result();
    expect(JSON.parse(engine.start.mock.calls.at(-1)![0]).scope).toBe(before.scope); runtime.shutdown();
  });
  it("hashes/protects model parameters and Max Mode, and uses the attested route rather than forged model.input", async () => {
    const { runtime, engine } = setup(); engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await runtime.discover(token);
    const run = async (id: string, reasoning?: "high" | "max") => {
      const result = await runtime.streamSimple(model(id), context(), { ...options, reasoning }).result(); expect(result.stopReason).toBe("stop");
      return JSON.parse(engine.start.mock.calls.at(-1)![0]);
    };
    const low = await run("family"), high = await run("family", "high"), max = await run("family", "max"), extended = await run("family-1m-max-mode-high-thinking-fast", "high");
    expect(new Set([low.scope, high.scope, max.scope, extended.scope]).size).toBe(4);
    expect(max.maxMode).toBe(false); expect(extended.maxMode).toBe(true);
    for (const onPayload of [
      (p: unknown) => ({ ...(p as object), modelParameters: [{ id: "reasoning", value: "low" }] }),
      (p: unknown) => ({ ...(p as object), maxMode: true }),
      (p: unknown) => { ((p as { modelParameters: { value: string }[] }).modelParameters[0]!).value = "low"; },
    ]) {
      const count = engine.start.mock.calls.length;
      const result = await runtime.streamSimple(model("family"), context(), { ...options, reasoning: "high", onPayload }).result();
      expect(result.stopReason).toBe("error"); expect(engine.start.mock.calls).toHaveLength(count);
    }
    const forged = context({ messages: [{ role: "user", timestamp: 1, content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }] });
    expect((await runtime.streamSimple(model("auto", true), forged, options).result()).errorMessage).toMatch(/does not advertise image/);
    expect((await runtime.streamSimple(model("family"), forged, options).result()).stopReason).toBe("stop");
    runtime.shutdown();
  });
});
