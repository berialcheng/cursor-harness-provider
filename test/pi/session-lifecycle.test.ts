import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { parameterizedCatalog } from "./catalog-fixture.js";
import { context, deferred, env, FakeStream, finish, jwt, model, setup, tick, token } from "./fixtures.js";

const options = { apiKey: token, sessionId: "session-a" };
// Exercise alternate spellings from untyped callers too: Pi itself uses undefined for off.
const reasoningOptions = (reasoning?: string) => ({ ...options, reasoning: reasoning as SimpleStreamOptions["reasoning"] });
const tools = [{ name: "read", description: "host-owned", parameters: { type: "object" } }];
const initial = () => context({ tools, messages: [{ role: "user", content: "read", timestamp: 1 }] });
const handoff = () => [
  { type: "tool-input-start", id: "c", toolName: "read" }, { type: "tool-input-delta", id: "c", delta: "{}" },
  { type: "tool-input-end", id: "c" }, { type: "tool-call", toolCallId: "c", toolName: "read", input: "{}" }, finish("tool-calls"),
];
const continuation = (assistant: AssistantMessage) => context({ tools, messages: [...initial().messages, assistant,
  { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "fixture result" }], isError: false, timestamp: 3 }] });
const payloads = (engine: ReturnType<typeof setup>["engine"]) => engine.start.mock.calls.map(([raw]) => JSON.parse(raw));
const runtimes: Array<ReturnType<typeof setup>["runtime"]> = [];
const fixture = (...args: Parameters<typeof setup>) => { const value = setup(...args); runtimes.push(value.runtime); return value; };
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.shutdown(); vi.useRealTimers(); });

async function pendingTools() {
  const h = fixture(handoff()); h.engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await h.runtime.discover(token);
  const assistant = await h.runtime.streamSimple(model("family"), initial(), options).result();
  expect(assistant.stopReason).toBe("toolUse");
  return { ...h, assistant, first: payloads(h.engine)[0] };
}

describe("Pi owned operational lifecycle", () => {
  it("has lazy, scoped, non-secret diagnostics and exact session ownership", () => {
    const { runtime, createEngine, system } = fixture();
    expect(runtime.ownsSession("session-a", "/tmp/pi-workspace/.")).toBe(true);
    expect(runtime.ownsSession("session-a", "/tmp/other")).toBe(false);
    expect(runtime.ownsSession("other", "/tmp/pi-workspace")).toBe(false);
    expect(runtime.recoveryScopes()).toEqual([]);
    expect(runtime.doctor()).toContain("known-scopes 0/128");
    expect(runtime.doctor()).toContain('"auth":0');
    expect(createEngine).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled();
  });
  it("rejects unknown and stale scopes without engine creation or auth", async () => {
    const { runtime, createEngine, engine, system } = fixture();
    await expect(runtime.resetScope("guessed")).rejects.toThrow(/unknown/);
    await expect(runtime.maintainCache("guessed", true)).rejects.toThrow(/unknown/);
    expect(createEngine).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled();
    await runtime.streamSimple(model(), context(), options).result();
    const scope = runtime.recoveryScopes()[0]!.scope;
    await runtime.resetScope(scope); expect(engine.remove).toHaveBeenCalledWith(scope);
    await expect(runtime.resetScope(scope)).rejects.toThrow(/unknown/);
    expect(engine.remove).toHaveBeenCalledOnce();
  });
  it("reports start and conservative action uncertainty before any tool event is read", async () => {
    const { runtime, engine } = fixture(); const start = deferred<FakeStream>(); engine.start.mockImplementationOnce(() => start.promise);
    const stream = runtime.streamSimple(model(), initial(), options); await tick();
    expect(runtime.recoveryScopes()).toEqual([expect.objectContaining({ state: "start", pendingStart: true, activeRequests: 1, mayHaveActions: true })]);
    expect(runtime.doctor()).toContain('"start":1'); expect(runtime.doctor()).not.toContain(token);
    start.resolve(new FakeStream([finish()])); expect((await stream.result()).stopReason).toBe("stop");
    expect(runtime.recoveryScopes()[0]).toMatchObject({ state: "idle", mayHaveActions: false, activeRequests: 0 });
  });
  it("resets only its own scope, fencing admission until the late start settles and is cancelled", async () => {
    const { runtime, engine } = fixture(); const start = deferred<FakeStream>(); const late = new FakeStream();
    engine.start.mockImplementationOnce(() => start.promise);
    const first = runtime.streamSimple(model(), initial(), options); await tick();
    const scope = runtime.recoveryScopes()[0]!.scope; const reset = runtime.resetScope(scope); await tick();
    expect((await first.result()).stopReason).toBe("aborted"); expect(engine.remove).not.toHaveBeenCalled();
    expect((await runtime.streamSimple(model(), initial(), options).result()).errorMessage).toMatch(/fenced/);
    expect((await runtime.streamSimple(model(), context(), { ...options, sessionId: "child" }).result()).stopReason).toBe("stop");
    start.resolve(late); await reset;
    expect(late.cancel).toHaveBeenCalledOnce(); expect(late.nextEvent).not.toHaveBeenCalled();
    expect(engine.remove).toHaveBeenCalledExactlyOnceWith(scope);
    await runtime.streamSimple(model(), context(), options).result(); await tick();
    expect(engine.remove).toHaveBeenCalledOnce();
  });
  it("times out reset without late deletion, keeps the scope fenced, and permits a new explicit reset", async () => {
    const { runtime, engine } = fixture(undefined, { env: () => ({ ...env, PI_CURSOR_RESET_TIMEOUT_MS: "10" }) });
    const start = deferred<FakeStream>(); engine.start.mockImplementationOnce(() => start.promise);
    const stream = runtime.streamSimple(model(), initial(), options); await tick();
    const scope = runtime.recoveryScopes()[0]!.scope;
    await expect(runtime.resetScope(scope)).rejects.toMatchObject({ code: "CURSOR_RESET_TIMEOUT" });
    expect((await stream.result()).stopReason).toBe("aborted"); expect(engine.remove).not.toHaveBeenCalled();
    expect(runtime.recoveryScopes()[0]).toMatchObject({ state: "fenced", pendingStart: true, mayHaveActions: true });
    start.resolve(new FakeStream()); await tick(); expect(engine.remove).not.toHaveBeenCalled();
    expect((await runtime.streamSimple(model(), context(), options).result()).errorMessage).toMatch(/fenced/);
    await runtime.resetScope(scope); expect(engine.remove).toHaveBeenCalledOnce();
  });
  it("does not remove a newer actor after cancelled start settlement or scope reuse", async () => {
    const { runtime, engine } = fixture(); const gate = deferred<FakeStream>(); engine.start.mockImplementationOnce(() => gate.promise);
    const abort = new AbortController(); const old = runtime.streamSimple(model(), context(), { ...options, signal: abort.signal }); await tick(); abort.abort();
    expect((await old.result()).stopReason).toBe("aborted");
    expect((await runtime.streamSimple(model(), context(), options).result()).errorMessage).toMatch(/active/);
    gate.resolve(new FakeStream()); await tick();
    expect((await runtime.streamSimple(model(), context(), options).result()).stopReason).toBe("stop");
    await tick(); expect(engine.remove).not.toHaveBeenCalled();
  });
  it("uses only optional native maintenance, supports dry-run/apply, and reports numeric resources without strings", async () => {
    const { runtime, engine } = fixture();
    const maintainCache = vi.fn(async () => JSON.stringify({ removed: 0 }));
    const resourceStats = vi.fn(() => JSON.stringify({ actors: 1, bytes: 64, secret: token, path: "/private/fixture" }));
    Object.assign(engine, { maintainCache, resourceStats });
    await runtime.streamSimple(model(), context(), options).result(); const scope = runtime.recoveryScopes()[0]!.scope;
    expect(await runtime.maintainCache(scope, false)).toEqual({ removed: 0 }); await runtime.maintainCache(scope, true);
    expect(maintainCache.mock.calls).toEqual([[scope, false], [scope, true]]);
    expect(runtime.doctor()).toContain('"actors":1'); expect(runtime.doctor()).not.toContain(token); expect(runtime.doctor()).not.toContain("/private/fixture");
  });
  it("reports root capacity from the latest commit and points capacity/expiry failures at explicit commands", async () => {
    const { runtime, engine } = fixture();
    const stats = { cacheLimitBytes: 1000, cacheLimitEntries: 10, cacheScanLimitEntries: 100, cacheCommittedBytes: 850, cacheRecords: 2, cacheDirectoryEntries: 6 };
    Object.assign(engine, { resourceStats: vi.fn(() => JSON.stringify(stats)) });
    await runtime.streamSimple(model(), context(), options).result();
    expect(runtime.doctor()).toContain("cacheRoot=CommittedBytes 85%, Records 20%, DirectoryEntries 6% (latest commit)");
    expect(runtime.doctor()).toContain("cacheWarning=root near capacity; inspect with /cursor.cache --select");
    stats.cacheCommittedBytes = 10; expect(runtime.doctor()).not.toContain("cacheWarning");
    engine.streams.push(new FakeStream([{ type: "error", error: "cache_quota_exceeded: the Cursor recovery cache root holds its 1 GiB of committed records" }]));
    expect((await runtime.streamSimple(model(), context(), { ...options, sessionId: "quota" }).result()).errorMessage)
      .toMatch(/^cache_quota_exceeded: .*Pi: \/cursor\.cache --select inspects the root/);
    engine.start.mockRejectedValueOnce(new Error("Recovery journal is expired, corrupt, oversized, or has a different binding; explicitly remove the scope to discard it"));
    expect((await runtime.streamSimple(model(), context(), { ...options, sessionId: "expired" }).result()).errorMessage)
      .toMatch(/explicitly remove the scope to discard it Pi: \/cursor\.reset --select discards/);
    engine.streams.push(new FakeStream([{ type: "error", error: "Cursor reply upload failed" }]));
    expect((await runtime.streamSimple(model(), context(), { ...options, sessionId: "other" }).result()).errorMessage).toBe("Cursor reply upload failed");
  });
  it("bounds maintenance and preserves the fence when native work ignores cancellation", async () => {
    const { runtime, engine } = fixture(undefined, { env: () => ({ ...env, PI_CURSOR_RESET_TIMEOUT_MS: "10" }) });
    const gate = deferred<string>(); Object.assign(engine, { maintainCache: vi.fn(() => gate.promise) });
    await runtime.streamSimple(model(), context(), options).result(); const scope = runtime.recoveryScopes()[0]!.scope;
    await expect(runtime.maintainCache(scope, true)).rejects.toMatchObject({ code: "CURSOR_CACHE_TIMEOUT" });
    expect(runtime.recoveryScopes()[0]!.state).toBe("fenced");
    await expect(runtime.resetScope(scope)).rejects.toThrow(/active/); gate.resolve("{}"); await tick();
    expect(runtime.recoveryScopes()[0]!.state).toBe("fenced"); await runtime.resetScope(scope);
  });
  it("does not admit a new actor while a timed-out remove can still settle late", async () => {
    const { runtime, engine } = fixture(undefined, { env: () => ({ ...env, PI_CURSOR_RESET_TIMEOUT_MS: "10" }) });
    await runtime.streamSimple(model(), context(), options).result(); const scope = runtime.recoveryScopes()[0]!.scope;
    const removal = deferred<void>(); engine.remove.mockImplementationOnce(() => removal.promise);
    await expect(runtime.resetScope(scope)).rejects.toMatchObject({ code: "CURSOR_RESET_TIMEOUT" });
    await expect(runtime.resetScope(scope)).rejects.toThrow(/active/);
    expect((await runtime.streamSimple(model(), context(), options).result()).errorMessage).toMatch(/fenced/);
    removal.resolve(); await tick(); await runtime.resetScope(scope);
    expect((await runtime.streamSimple(model(), context(), options).result()).stopReason).toBe("stop");
    expect(engine.remove).toHaveBeenCalledTimes(2);
  });
  it("rejects stale auth that only identifies its exact scope after reset completes", async () => {
    const { runtime, engine } = fixture();
    await runtime.streamCompat(model(), context(), options, "owner", async () => ({ apiKey: token })).result();
    const scope = runtime.recoveryScopes()[0]!.scope; const gate = deferred<{ apiKey: string }>();
    const stale = runtime.streamCompat(model(), context(), options, "owner", () => gate.promise); await tick();
    await runtime.resetScope(scope); gate.resolve({ apiKey: token });
    expect((await stale.result()).errorMessage).toMatch(/predates/); expect(engine.start).toHaveBeenCalledOnce();
    expect((await runtime.streamCompat(model(), context(), options, "owner", async () => ({ apiKey: token })).result()).stopReason).toBe("stop");
  });
  it("does not fence or leak an operation on pre-aborted recovery", async () => {
    const { runtime, engine } = fixture(); await runtime.streamSimple(model(), context(), options).result();
    const scope = runtime.recoveryScopes()[0]!.scope; const abort = new AbortController(); abort.abort();
    await expect(runtime.resetScope(scope, abort.signal)).rejects.toBeDefined();
    expect(runtime.recoveryScopes()[0]!.state).toBe("idle"); expect(engine.remove).not.toHaveBeenCalled();
    expect(runtime.doctor()).toContain("activeRequests=0");
  });
  it("keeps its durable registry bounded without evicting pending tool/action scopes", async () => {
    const { runtime, engine } = fixture();
    for (let i = 0; i < 130; i++) await runtime.streamSimple(model(), context(), { ...options, sessionId: `child-${i}` }).result();
    expect(runtime.recoveryScopes()).toHaveLength(128);
    const stale = payloads(engine)[0].scope; await expect(runtime.resetScope(stale)).rejects.toThrow(/unknown/);
    expect(engine.remove).not.toHaveBeenCalled();
    const pending = fixture();
    for (let i = 0; i < 128; i++) {
      pending.engine.streams.push(new FakeStream(handoff()));
      await pending.runtime.streamSimple(model(), initial(), { ...options, sessionId: `tools-${i}` }).result();
    }
    expect((await pending.runtime.streamSimple(model(), initial(), { ...options, sessionId: "over-capacity" }).result()).errorMessage).toMatch(/capacity/);
    expect(pending.engine.start).toHaveBeenCalledTimes(128);
    expect(pending.runtime.recoveryScopes().every(s => s.state === "awaiting-tools" && s.mayHaveActions)).toBe(true);
  });
  it("bounds canonical compat auth and owned hooks, independently of the stream idle timeout", async () => {
    const { runtime, engine } = fixture(undefined, { env: () => ({ ...env, PI_CURSOR_AUTH_TIMEOUT_MS: "10" }) });
    const auth = deferred<{ apiKey: string }>(); const resolveAuth = vi.fn(() => auth.promise);
    const stream = runtime.streamCompat(model(), context(), { ...options, timeoutMs: 1 }, "owner", resolveAuth);
    expect(runtime.doctor()).toContain('"auth":1');
    expect((await stream.result()).errorMessage).toMatch(/authentication timed out/); expect(engine.start).not.toHaveBeenCalled();
    auth.resolve({ apiKey: token }); await tick(); expect(engine.start).not.toHaveBeenCalled();
    expect((await runtime.streamSimple(model(), context(), { ...options, onPayload: () => new Promise(() => {}) }).result()).errorMessage).toMatch(/hook timed out/);
    await runtime.streamSimple(model(), context(), { ...options, timeoutMs: 7 }).result(); expect(payloads(engine)[0].idleTimeoutMs).toBe(7);
  });
  it("maps Pi's disabled or longer HTTP idle timeout to the bounded native maximum", async () => {
    const { runtime, engine } = fixture();
    for (const timeoutMs of [2147483647, 0, 3600001, 3600000]) {
      expect((await runtime.streamSimple(model(), context(), { ...options, timeoutMs }).result()).stopReason).not.toBe("error");
    }
    expect(payloads(engine).map(payload => payload.idleTimeoutMs)).toEqual([3600000, 3600000, 3600000, 3600000]);
    for (const timeoutMs of [-1, 1.5, Number.NaN]) {
      expect((await runtime.streamSimple(model(), context(), { ...options, timeoutMs }).result()).errorMessage).toMatch(/Invalid idle timeout/);
    }
    expect(engine.start).toHaveBeenCalledTimes(4);
  });
});

describe("Pi route pins belong only to a verified pending tool turn", () => {
  it.each(["changed-default", "missing-metadata", "removed"])("retains its attested route across %s and releases it at the non-tool boundary", async change => {
    const { runtime, engine, assistant, first } = await pendingTools();
    const updated = structuredClone(parameterizedCatalog);
    if (change === "changed-default") { updated[0]!.parameterized!.variants[0]!.isDefaultNonMaxConfig = false; updated[0]!.parameterized!.variants[0]!.parameters[0]!.value = "low"; Object.assign(updated[0]!.parameterized!.variants[1]!, { isDefaultNonMaxConfig: true }); }
    if (change === "missing-metadata") delete (updated[0] as { parameterized?: unknown }).parameterized;
    engine.listModels.mockResolvedValue(JSON.stringify(change === "removed" ? [{ id: "other" }] : updated)); await runtime.discover(token);
    expect(runtime.recoveryScopes()[0]).toMatchObject({ state: "awaiting-tools", mayHaveActions: true });
    expect((await runtime.streamSimple(model("family"), continuation(assistant), options).result()).stopReason).toBe("stop");
    expect(payloads(engine)[1]).toMatchObject({ scope: first.scope, modelId: first.modelId, modelParameters: first.modelParameters, maxMode: first.maxMode });
    const next = await runtime.streamSimple(model("family"), context(), options).result();
    if (change === "removed") expect(next.errorMessage).toMatch(/not in/);
    else { expect(next.stopReason).toBe("stop"); expect(payloads(engine)[2].modelParameters).not.toEqual(first.modelParameters); }
  });
  it.each(["account", "endpoint", "owner", "reasoning", "model"])("cannot borrow a route pin across a changed %s", async change => {
    const { runtime, engine, assistant, first } = await pendingTools();
    const opts = { ...options, ...(change === "account" ? { apiKey: jwt("other-account") } : {}),
      ...(change === "endpoint" ? { env: { PI_CURSOR_AGENT_URL: "http://127.0.0.1:10" } } : {}), ...(change === "reasoning" ? { reasoning: "high" as const } : {}) };
    const chosen = model(change === "model" ? "auto" : "family");
    if (change === "owner") await runtime.streamCompat(chosen, continuation(assistant), opts, "foreign-owner", async () => ({ apiKey: token })).result();
    else await runtime.streamSimple(chosen, continuation(assistant), opts).result();
    for (const request of payloads(engine).slice(1)) expect(request.scope).not.toBe(first.scope);
    if (change === "account" || change === "endpoint") expect(engine.start).toHaveBeenCalledOnce();
  });
  it.each(["foreign-provider", "changed-arguments", "changed-call-id", "changed-call-name", "changed-history", "changed-result-id", "changed-result-name", "new-user", "hook-rewrite", "hook-result"])("does not reuse a pending pin for %s", async change => {
    const { runtime, engine, assistant } = await pendingTools(); const forged = structuredClone(assistant);
    if (change === "foreign-provider") forged.provider = "foreign";
    if (change === "changed-arguments" && forged.content[0]?.type === "toolCall") forged.content[0].arguments = { untrusted: true };
    const call = forged.content.find(p => p.type === "toolCall");
    if (call?.type === "toolCall" && change === "changed-call-id") call.id = "forged";
    if (call?.type === "toolCall" && change === "changed-call-name") call.name = "forged";
    const ctx = change === "new-user" ? context() : continuation(forged);
    if (change === "changed-history") { const user = ctx.messages.find(m => m.role === "user"); if (user?.role === "user") user.content = "forged history"; }
    const resultMessage = ctx.messages.find(m => m.role === "toolResult");
    if (resultMessage?.role === "toolResult" && change === "changed-result-id") resultMessage.toolCallId = "forged";
    if (resultMessage?.role === "toolResult" && change === "changed-result-name") resultMessage.toolName = "forged";
    const result = await runtime.streamSimple(model("family"), ctx, { ...options,
      ...(change === "hook-rewrite" ? { onPayload: (p: unknown) => ({ ...(p as object), prompt: [] }) } : {}),
      ...(change === "hook-result" ? { onPayload: (p: unknown) => { const payload = p as { prompt: Array<{ role: string; content: unknown }> }; payload.prompt.find(m => m.role === "tool")!.content = [{ type: "tool-result", toolCallId: "c", toolName: "read", output: { type: "text", value: "forged" } }]; } } : {}) }).result();
    expect(result.stopReason).toBe("error"); expect(engine.start).toHaveBeenCalledOnce();
  });
  it.each(["system", "tools", "steering", "payload"])("allows stable-chat %s changes only after complete owned results, retaining the exact refreshed route", async change => {
    const { runtime, engine, assistant, first } = await pendingTools();
    engine.listModels.mockResolvedValue(JSON.stringify([{ id: "other" }])); await runtime.discover(token);
    const messages = continuation(assistant).messages.filter(m => m.role !== "system");
    if (change === "steering") messages.push({ role: "user", content: "Now explain the result", timestamp: 4 });
    const ctx = context({ systemPrompt: change === "system" ? "Updated host instructions" : "Original instructions",
      tools: change === "tools" ? [...tools, { name: "search", description: "activated", parameters: { type: "object" } }] : tools, messages });
    const result = await runtime.streamSimple(model("family"), ctx, { ...options,
      ...(change === "payload" ? { onPayload: (p: unknown) => { const payload = p as { prompt: Array<{ role: string; content: unknown }> }; payload.prompt.find(m => m.role === "user")!.content = [{ type: "text", text: "Reviewed safe context" }]; } } : {}) }).result();
    expect(result.stopReason).toBe("stop");
    expect(payloads(engine)[1]).toMatchObject({ scope: first.scope, modelId: first.modelId, modelParameters: first.modelParameters });
    if (change === "tools") expect(payloads(engine)[1].tools.map((t: { name: string }) => t.name)).toEqual(["read", "search"]);
  });
  it.each(["off", "high"] as const)("does not bypass a pending handoff with %s, but permits it at an idle boundary", async reasoning => {
    const { runtime, engine, assistant, first } = await pendingTools();
    expect((await runtime.streamSimple(model("family"), continuation(assistant), reasoningOptions(reasoning)).result()).errorMessage).toMatch(/pending tool handoff/);
    expect(engine.start).toHaveBeenCalledOnce();
    expect((await runtime.streamSimple(model("family"), continuation(assistant), options).result()).stopReason).toBe("stop");
    expect((await runtime.streamSimple(model("family"), context(), reasoningOptions(reasoning)).result()).stopReason).toBe("stop");
    expect(payloads(engine)[2].scope === first.scope).toBe(reasoning === "off");
  });
  it.each(["off", "high"] as const)("fences queued pre-reset auth across requested %s spelling", async reasoning => {
    const { runtime, engine } = fixture(); engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await runtime.discover(token);
    await runtime.streamCompat(model("family"), context(), options, "owner", async () => ({ apiKey: token })).result();
    const gate = deferred<{ apiKey: string }>();
    const stale = runtime.streamCompat(model("family"), context(), reasoningOptions(reasoning), "owner", () => gate.promise); await tick();
    await runtime.resetScope(runtime.recoveryScopes()[0]!.scope); gate.resolve({ apiKey: token });
    expect((await stale.result()).errorMessage).toMatch(/predates/); expect(engine.start).toHaveBeenCalledOnce();
    expect((await runtime.streamCompat(model("family"), context(), reasoningOptions(reasoning), "owner", async () => ({ apiKey: token })).result()).stopReason).toBe("stop");
  });
  it("keeps alternate reasoning fenced during an inflight native start", async () => {
    const { runtime, engine } = fixture(); engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await runtime.discover(token);
    const gate = deferred<FakeStream>(); engine.start.mockImplementationOnce(() => gate.promise);
    const active = runtime.streamSimple(model("family"), context(), options); await tick();
    expect((await runtime.streamSimple(model("family"), context(), reasoningOptions("off")).result()).errorMessage).toMatch(/active/);
    expect(engine.start).toHaveBeenCalledOnce(); gate.resolve(new FakeStream()); await active.result();
  });
  it("does not silently reuse a default-medium pin for an unsupported off request", async () => {
    const { runtime, engine } = fixture(handoff());
    const catalog = structuredClone(parameterizedCatalog);
    catalog[0]!.parameterized!.variants[0]!.parameters[0]!.value = "medium";
    engine.listModels.mockResolvedValue(JSON.stringify(catalog)); await runtime.discover(token);
    const assistant = await runtime.streamSimple(model("family"), initial(), options).result();
    expect(payloads(engine)[0].modelParameters).toContainEqual({ id: "reasoning", value: "medium" });
    expect((await runtime.streamSimple(model("family"), continuation(assistant), reasoningOptions("off")).result()).errorMessage).toMatch(/pending tool handoff/);
    expect(engine.start).toHaveBeenCalledOnce();
    expect((await runtime.streamSimple(model("family"), continuation(assistant), options).result()).stopReason).toBe("stop");
  });
  it("preserves native error uncertainty across failed preflight and alternate reasoning", async () => {
    const { runtime, engine } = fixture([{ type: "error", error: "fixture native failure" }]);
    engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await runtime.discover(token);
    expect((await runtime.streamSimple(model("family"), context(), options).result()).stopReason).toBe("error");
    expect((await runtime.streamSimple(model("family"), context(), { ...reasoningOptions("off"), onPayload: () => ({}) }).result()).stopReason).toBe("error");
    expect(runtime.recoveryScopes()[0]!.state).toBe("error");
    expect((await runtime.streamSimple(model("family"), context(), reasoningOptions("high")).result()).errorMessage).toMatch(/uncertain prior route/);
    expect(engine.start).toHaveBeenCalledOnce();
  });
  it("rejects undefined as an alternate spelling of an explicitly off pending route", async () => {
    const { runtime, engine } = fixture(handoff()); engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await runtime.discover(token);
    const assistant = await runtime.streamSimple(model("family"), initial(), reasoningOptions("off")).result();
    expect((await runtime.streamSimple(model("family"), continuation(assistant), options).result()).errorMessage).toMatch(/pending tool handoff/);
    expect(engine.start).toHaveBeenCalledOnce();
    expect((await runtime.streamSimple(model("family"), continuation(assistant), reasoningOptions("off")).result()).stopReason).toBe("stop");
  });
  it.each(["missing-result", "steering-before-results"])("rejects %s before a fully reconciled multi-call boundary", async change => {
    const second = handoff().slice(0, -1).map(e => ({ ...e, ...("id" in e ? { id: "d" } : {}), ...("toolCallId" in e ? { toolCallId: "d" } : {}) }));
    const { runtime, engine } = fixture([...handoff().slice(0, -1), ...second, finish("tool-calls")]);
    engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await runtime.discover(token);
    const assistant = await runtime.streamSimple(model("family"), initial(), options).result();
    const ctx = continuation(assistant);
    if (change === "steering-before-results") ctx.messages.splice(ctx.messages.length - 1, 0, { role: "user", content: "premature steering", timestamp: 4 });
    expect((await runtime.streamSimple(model("family"), ctx, options).result()).errorMessage).toMatch(/pending tool handoff/);
    expect(engine.start).toHaveBeenCalledOnce();
    const complete = continuation(assistant);
    complete.messages.push({ role: "toolResult", toolCallId: "d", toolName: "read", content: [{ type: "text", text: "second result" }], isError: false, timestamp: 4 }, { role: "user", content: "safe steering", timestamp: 5 });
    expect((await runtime.streamSimple(model("family"), complete, options).result()).stopReason).toBe("stop");
  });
  it("allows a deterministic payload hook while protecting its issued assistant and tool history", async () => {
    const h = fixture(handoff()); h.engine.listModels.mockResolvedValue(JSON.stringify(parameterizedCatalog)); await h.runtime.discover(token);
    const onPayload = (value: unknown) => {
      const p = value as { prompt: Array<{ role: string; content: unknown }> };
      p.prompt[0]!.content = [{ type: "text", text: "hook-reviewed fixture task" }];
    };
    const first = await h.runtime.streamSimple(model("family"), initial(), { ...options, onPayload }).result();
    expect(first.stopReason).toBe("toolUse");
    h.engine.listModels.mockResolvedValue(JSON.stringify([{ id: "other" }])); await h.runtime.discover(token);
    expect((await h.runtime.streamSimple(model("family"), continuation(first), { ...options, onPayload }).result()).stopReason).toBe("stop");
    expect(payloads(h.engine)[1].scope).toBe(payloads(h.engine)[0].scope);
  });
  it("retains uncertainty after a failed continuation and disallows route-changing implicit retries", async () => {
    const { runtime, engine, assistant } = await pendingTools(); engine.streams.push(new FakeStream([{ type: "error", error: "fixture failure" }]));
    expect((await runtime.streamSimple(model("family"), continuation(assistant), options).result()).stopReason).toBe("error");
    expect(runtime.recoveryScopes()[0]).toMatchObject({ state: "error", mayHaveActions: true }); expect(engine.remove).not.toHaveBeenCalled();
    expect((await runtime.streamSimple(model("family"), context(), options).result()).errorMessage).toMatch(/pending tool handoff/);
  });
});
