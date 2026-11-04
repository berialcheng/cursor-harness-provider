import { describe, expect, it, vi } from "vitest";
import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AGENT_URL } from "../../packages/pi/src/constants.js";
import { PiRustRuntime } from "../../packages/pi/src/runtime.js";
import { accountPartition, safeError } from "../../packages/pi/src/security.js";
import { collect, context, deferred, env, FakeEngine, FakeStream, fakeAuth, finish, infrastructureNotices, jwt, model, setup, textEvents, tick, token } from "./fixtures.js";

const opts = { apiKey: token, sessionId: "session-a" };
const terminal = (events: AssistantMessageEvent[]) => events.filter(e => e.type === "error" || e.type === "done");
const toolsContext = () => context({ systemPrompt: "tool instructions", tools: [{ name: "read", description: "host read", parameters: { type: "object" } }], messages: [{ role: "user", content: "read", timestamp: 1 }] });

describe("session-owned Rust stream adapter", () => {
  it("is lazy and shuts an unused runtime down without constructing a binding", () => {
    const { runtime, createEngine, system } = setup();
    runtime.shutdown(); runtime.shutdown();
    expect(createEngine).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled();
  });
  it("balances text/thinking/tools and updates blocks before exposing each content index", async () => {
    const input = '{"path":"fixture"}';
    const { runtime, engine } = setup([
      { type: "response-metadata", id: "response-1", modelId: "resolved-model" },
      { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "考虑🙂" }, { type: "reasoning-end", id: "r" },
      { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "你好𠮷" }, { type: "text-end", id: "t" },
      { type: "tool-input-start", id: "c", toolName: "read" }, { type: "tool-input-delta", id: "c", delta: input },
      { type: "tool-input-end", id: "c" }, { type: "tool-call", toolCallId: "c", toolName: "read", input, providerExecuted: false },
      finish("tool-calls", { inputTokens: { total: 150, noCache: 100, cacheRead: 40, cacheWrite: 10 }, outputTokens: { total: 20, reasoning: 7 } }),
    ]);
    const stream = runtime.streamSimple(model(), toolsContext(), opts);
    // Pi's SDK exposes one mutable message reference. Capture emission-time states
    // before the first auth await resumes, not later while draining queued events.
    const emitted: AssistantMessageEvent[] = [], originalPush = stream.push.bind(stream);
    const push = vi.spyOn(stream, "push").mockImplementation(event => { emitted.push(structuredClone(event)); originalPush(event); });
    const events = await collect(stream), result = await stream.result();
    expect(events.map(e => e.type)).toEqual(["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
    expect(events.filter(e => "contentIndex" in e).map(e => "contentIndex" in e ? e.contentIndex : -1)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    expect(emitted[1]).toMatchObject({ partial: { content: [{ type: "thinking", thinking: "" }] } });
    expect(emitted[2]).toMatchObject({ partial: { content: [{ type: "thinking", thinking: "考虑🙂" }] } });
    for (const [event] of push.mock.calls) if ("partial" in event) expect(event.partial).toBe(result);
    expect(result.content[2]).toEqual({ type: "toolCall", id: "c", name: "read", arguments: { path: "fixture" } });
    expect(result).toMatchObject({ stopReason: "toolUse", responseId: "response-1", responseModel: "resolved-model", usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, totalTokens: 170, reasoning: 7 } });
    expect(result.usage.cost.total).toBeCloseTo(0.000393);
    expect(engine.remove).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("accepts empty successful output, with explicit unknown-usage diagnostics", async () => {
    const { runtime } = setup([finish()]);
    const stream = runtime.streamSimple(model(), context(), opts), events = await collect(stream);
    expect(events.map(e => e.type)).toEqual(["start", "done"]);
    const result = await stream.result();
    expect(result.content).toEqual([]); expect(result.usage.totalTokens).toBe(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "cursor_native_usage", details: expect.objectContaining({ tokens: "unreported", cache: "unreported" }) }));
    runtime.shutdown();
  });
  it.each([
    [{ type: "text-delta", id: "missing", delta: "invalid" }],
    [{ type: "text-start", id: "x" }, { type: "text-start", id: "x" }],
    [{ type: "tool-input-start", id: "c", toolName: "unavailable" }],
    [{ type: "tool-input-start", id: "c", toolName: "read", providerExecuted: true }],
    [{ type: "text-start", id: "x" }, finish()],
    [{ type: "unexpected-new-protocol" }],
    [],
  ])("fails closed on malformed/partial streams with one terminal and balanced open blocks", async (...parts) => {
    const { runtime } = setup(parts);
    const events = await collect(runtime.streamSimple(model(), toolsContext(), opts));
    expect(terminal(events)).toHaveLength(1); expect(terminal(events)[0]!.type).toBe("error");
    const starts = events.filter(e => e.type === "text_start");
    expect(events.filter(e => e.type === "text_end")).toHaveLength(starts.length);
    runtime.shutdown();
  });
  it("ends an incomplete tool block safely but never presents valid executable arguments", async () => {
    const { runtime } = setup([{ type: "tool-input-start", id: "c", toolName: "read" }, { type: "tool-input-delta", id: "c", delta: '{"path":' }]);
    const events = await collect(runtime.streamSimple(model(), toolsContext(), opts));
    expect(events.map(e => e.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "error"]);
    expect(events[3]).toMatchObject({ toolCall: { arguments: {}, argumentsError: expect.stringMatching(/incomplete/) } });
    runtime.shutdown();
  });
  it("does not execute after toolChoice:none or accept invalid authoritative argument JSON", async () => {
    const { runtime } = setup([{ type: "tool-input-start", id: "c", toolName: "read" }]);
    expect((await runtime.streamSimple(model(), toolsContext(), { ...opts, toolChoice: "none" }).result()).stopReason).toBe("error");
    runtime.shutdown();
  });
  it("aborts before auth/native start and preserves exactly one terminal event", async () => {
    const { runtime, createEngine, system } = setup(); const abort = new AbortController(); abort.abort();
    const stream = runtime.streamSimple(model(), context(), { signal: abort.signal });
    const events = await collect(stream);
    expect(events.map(e => e.type)).toEqual(["error"]); expect(await stream.result()).toMatchObject({ stopReason: "aborted", errorMessage: expect.any(String) });
    expect(createEngine).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("cancels a late start promise and removes a stateless scope only after the late receiver exists", async () => {
    const { runtime, engine } = setup(); const pending = deferred<FakeStream>(), handle = new FakeStream();
    engine.start.mockImplementationOnce(() => pending.promise);
    const abort = new AbortController();
    const stream = runtime.streamSimple(model(), context(), { apiKey: token, signal: abort.signal });
    await tick(); expect(engine.start).toHaveBeenCalledOnce(); abort.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(engine.remove).not.toHaveBeenCalled();
    pending.resolve(handle); await tick();
    expect(handle.cancel).toHaveBeenCalledOnce(); expect(engine.remove).toHaveBeenCalledOnce();
    expect(handle.nextEvent).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("aborts a pending nextEvent and idempotently shuts down its owned engine", async () => {
    const { runtime, engine } = setup(), handle = new FakeStream(), pending = deferred<string | null>();
    handle.nextEvent.mockImplementationOnce(() => pending.promise); engine.streams.push(handle);
    const stream = runtime.streamSimple(model(), context(), opts); await tick();
    runtime.shutdown(); runtime.shutdown();
    const events = await collect(stream);
    expect(terminal(events)).toHaveLength(1); expect(await stream.result()).toMatchObject({ stopReason: "aborted" });
    expect(handle.cancel).toHaveBeenCalledOnce(); expect(engine.shutdown).toHaveBeenCalledOnce();
    pending.reject(new Error("late receiver failure")); await tick(); // no unhandled rejection
  });
  it("removes each successful auxiliary scope, but retains a chat checkpoint for host tool results", async () => {
    const { runtime, engine } = setup();
    await runtime.streamSimple(model(), context(), opts).result(); await tick(); expect(engine.remove).not.toHaveBeenCalled();
    await runtime.streamSimple(model(), context(), { ...opts, cacheRetention: "none" }).result(); await tick();
    expect(engine.remove).toHaveBeenCalledOnce(); runtime.shutdown();
  });
  it("keeps host/account/model/workspace/session/request-kind identities separate", async () => {
    const { runtime, engine } = setup();
    const run = async (options = opts) => { await runtime.streamSimple(model(), context(), options).result(); return JSON.parse(engine.start.mock.calls.at(-1)![0]) as { scope: string; stateless: boolean; cacheDir: string }; };
    const a = await run(), again = await run(); expect(a.scope).toBe(again.scope);
    const rotation = await run({ ...opts, apiKey: jwt("fixture-a", "rotated") }); expect(rotation.scope).toBe(a.scope);
    const account = await run({ ...opts, apiKey: jwt("fixture-b") }); expect(account.scope).not.toBe(a.scope);
    const otherSession = await run({ ...opts, sessionId: "other-session" }); expect(otherSession.scope).not.toBe(a.scope); expect(otherSession.stateless).toBe(true);
    await runtime.streamSimple(model(), context(), { ...opts, cacheRetention: "none" }).result();
    const summary = JSON.parse(engine.start.mock.calls.at(-1)![0]); expect(summary.scope).not.toBe(a.scope); expect(summary.stateless).toBe(true);
    expect(a.scope).toMatch(/^[0-9a-f]{64}$/); expect(a.cacheDir).toContain("/pi/rust-sessions-v1");
    const openCodeScope = createOtherHostScope(); expect(a.scope).not.toBe(openCodeScope);
    const different = setup(); different.runtime.setSession; // workspace isolation uses a distinct session-owned runtime
    different.runtime.shutdown();
    const workEngine = new FakeEngine(), work = new PiRustRuntime({ createEngine: () => workEngine, auth: fakeAuth().auth, env: () => env });
    work.setSession({ sessionId: "session-a", workspace: "/tmp/other-workspace" });
    await work.streamSimple(model(), context(), opts).result(); expect(JSON.parse(workEngine.start.mock.calls[0]![0]).scope).not.toBe(a.scope);
    runtime.shutdown(); work.shutdown();
  });
  it("normalizes only context overflow and redacts credential-bearing native errors", async () => {
    for (const [error, expected] of [["maximum context length exceeded", /context_length_exceeded/], ["429 rate limit", /^429 rate limit/], [`bad Bearer ${token} access_token=${token}`, /REDACTED/]] as const) {
      const { runtime } = setup([{ type: "error", error }]);
      const result = await runtime.streamSimple(model(), context(), opts).result();
      expect(result.errorMessage).toMatch(expected); expect(result.errorMessage).not.toContain(token); runtime.shutdown();
    }
    expect(safeError("cookie=fixture-cookie authorization=fixture-key")).not.toMatch(/fixture-/);
    expect(accountPartition("opaque-a")).not.toBe(accountPartition("opaque-b"));
  });
});
function createOtherHostScope(): string { return "not-a-pi-host-scope"; }

describe("Pi request instrumentation", () => {
  it("passes the actual nonsecret normalized DTO, using payload replacements for native.start", async () => {
    const { runtime, engine } = setup();
    const onPayload = vi.fn(async (payload: unknown) => {
      const request = payload as Record<string, unknown>;
      expect(request.scope).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(request)).not.toContain(token);
      expect(request.prompt).toEqual([{ role: "system", content: "fixture instructions" }, { role: "user", content: [{ type: "text", text: "hello" }] }]);
      return { ...request, prompt: [{ role: "system", content: "replacement instructions" }, { role: "user", content: [{ type: "text", text: "replacement" }] }] };
    });
    const onResponse = vi.fn();
    expect((await runtime.streamSimple(model(), context(), { ...opts, onPayload, onResponse }).result()).stopReason).toBe("stop");
    expect(onPayload).toHaveBeenCalledOnce(); expect(onResponse).not.toHaveBeenCalled();
    expect(JSON.parse(engine.start.mock.calls[0]![0]).prompt[0].content).toBe("replacement instructions"); runtime.shutdown();
  });
  it.each(["scope", "modelId", "workspace", "cacheDir", "agentUrl", "stateless"])("prevents a payload hook replacing protected %s", async key => {
    const { runtime, engine } = setup();
    const result = await runtime.streamSimple(model(), context(), { ...opts, onPayload: payload => ({ ...(payload as object), [key]: "attacker" }) }).result();
    expect(result.stopReason).toBe("error"); expect(engine.start).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("rejects hidden auth/new fields and actually missing payload parts", async () => {
    for (const change of ["auth", "null", "prompt", "tools"]) {
      const { runtime, engine } = setup();
      const onPayload = (payload: unknown) => {
        if (change === "null") return null;
        const replacement = { ...(payload as Record<string, unknown>) };
        if (change === "auth") replacement.accessToken = "fixture-injection";
        else delete replacement[change];
        return replacement;
      };
      expect((await runtime.streamSimple(model(), context(), { ...opts, onPayload }).result()).stopReason).toBe("error");
      expect(engine.start).not.toHaveBeenCalled(); runtime.shutdown();
    }
  });
  it("accepts a replacement with empty but present prompt and tools", async () => {
    const { runtime, engine } = setup();
    const result = await runtime.streamSimple(model(), context(), { ...opts,
      onPayload: payload => ({ ...(payload as object), prompt: [], tools: [] }) }).result();
    expect(result.stopReason).toBe("stop");
    expect(JSON.parse(engine.start.mock.calls[0]![0])).toMatchObject({ prompt: [], tools: [] }); runtime.shutdown();
  });
  it("awaits structured provider events in order and isolates observer mutation", async () => {
    const { runtime, engine } = setup(); const handle = new FakeStream(); engine.streams.push(handle);
    const gate = deferred<void>(); let calls = 0;
    const onProviderStreamEvent = vi.fn(async (value: unknown) => {
      const event = value as Record<string, unknown>;
      if (++calls === 1) await gate.promise;
      if (event.type === "text-delta") event.delta = "observer mutation must not alter output";
    });
    const stream = runtime.streamSimple(model(), context(), { ...opts, onProviderStreamEvent });
    await tick(); expect(handle.nextEvent).toHaveBeenCalledTimes(1); gate.resolve();
    expect((await stream.result()).content).toEqual([{ type: "text", text: "hello" }]);
    expect(onProviderStreamEvent).toHaveBeenCalledTimes(4); runtime.shutdown();
  });
  it("normalizes mixed infrastructure and recovery memory before the payload hook/native boundary", async () => {
    const { runtime, engine } = setup();
    const source = context({ systemPrompt: "Base", messages: [{ role: "user", timestamp: 1, content: [
      { type: "text", text: `Please review this image.\n\n${infrastructureNotices.context}\n\n${infrastructureNotices.compaction}` },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ] }] });
    const onPayload = vi.fn((payload: unknown) => {
      const request = payload as { prompt: unknown[]; tools: unknown[] };
      expect(request.prompt).toEqual([
        { role: "system", content: expect.stringContaining("recovered conversation context") },
        { role: "user", content: [{ type: "text", text: "Please review this image." }, { type: "file", data: "aGVsbG8=", mediaType: "image/png" }] },
      ]);
      expect(JSON.stringify(request.prompt[0])).toContain("Prior work: fixture auth");
      expect(request.tools).toEqual([]);
    });
    expect((await runtime.streamSimple(model("auto", true), source, { ...opts, onPayload }).result()).stopReason).toBe("stop");
    expect(onPayload).toHaveBeenCalledOnce(); expect(JSON.parse(engine.start.mock.calls[0]![0]).tools).toEqual([]); runtime.shutdown();
  });
  it("rejects a hook-added image when the chosen model has no image capability", async () => {
    const { runtime, engine } = setup();
    const result = await runtime.streamSimple(model(), context(), { ...opts, onPayload: payload => ({ ...(payload as object),
      prompt: [{ role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png" }] }] }) }).result();
    expect(result.errorMessage).toMatch(/does not advertise image/); expect(engine.start).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("aborts a stalled payload hook without starting native inference", async () => {
    const { runtime, engine } = setup(), gate = deferred<void>(), abort = new AbortController();
    const stream = runtime.streamSimple(model(), context(), { ...opts, signal: abort.signal, onPayload: async () => { await gate.promise; } });
    await tick(); abort.abort();
    expect((await stream.result()).stopReason).toBe("aborted"); expect(engine.start).not.toHaveBeenCalled(); gate.resolve(); await tick(); runtime.shutdown();
  });
});

describe("Pi inference routing and unsupported controls", () => {
  it.each([
    [{}, AGENT_URL],
    [{ CURSOR_AGENT_URL: "http://127.0.0.1:9101" }, "http://127.0.0.1:9101"],
    [{ CURSOR_AGENT_URL: "http://127.0.0.1:9101", PI_CURSOR_AGENT_URL: "http://127.0.0.1:9102" }, "http://127.0.0.1:9102"],
  ] as const)("uses the canonical agent route or scoped URL overrides, never the OAuth api2 default", async (overrides, expected) => {
    const environment = { PI_CURSOR_SYSTEM_CREDENTIALS: "0", PI_CURSOR_CACHE_DIR: "/tmp/pi-cursor-fixture", ...overrides };
    const before = { pi: process.env.PI_CURSOR_AGENT_URL, cursor: process.env.CURSOR_AGENT_URL };
    const { runtime, engine } = setup(undefined, { env: () => environment });
    const chosen = { ...model(), baseUrl: AGENT_URL };
    expect((await runtime.streamSimple(chosen, context(), opts).result()).stopReason).toBe("stop");
    expect(JSON.parse(engine.start.mock.calls[0]![0]).agentUrl).toBe(expected);
    await runtime.discover(token, undefined, undefined, AGENT_URL);
    expect(engine.listModels.mock.calls[0]![1]).toBe(expected);
    expect({ pi: process.env.PI_CURSOR_AGENT_URL, cursor: process.env.CURSOR_AGENT_URL }).toEqual(before);
    runtime.shutdown();
  });
  it("applies per-request environment without changing the process or runtime base environment", async () => {
    const { runtime, engine } = setup(), before = { ...env };
    await runtime.streamSimple(model(), context(), { ...opts, env: { PI_CURSOR_AGENT_URL: "http://127.0.0.1:9103" } }).result();
    expect(JSON.parse(engine.start.mock.calls[0]![0]).agentUrl).toBe("http://127.0.0.1:9103"); expect(env).toEqual(before); runtime.shutdown();
  });
  it.each([
    { headers: { "x-fixture": "unsupported" } },
    { headers: { "x-fixture": null } },
    { fetch: vi.fn<typeof fetch>() },
    { deferred: true },
  ] satisfies SimpleStreamOptions[])("rejects unsupported transport control before auth/native work", async options => {
    const { runtime, engine, system } = setup();
    const result = await runtime.streamSimple(model(), context(), { ...opts, ...options }).result();
    expect(result.stopReason).toBe("error"); expect(engine.start).not.toHaveBeenCalled(); expect(system).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("does not silently accept model-specific HTTP headers", async () => {
    const { runtime, engine } = setup();
    const result = await runtime.streamSimple({ ...model(), headers: { "x-fixture": "unsupported" } }, context(), opts).result();
    expect(result.errorMessage).toMatch(/custom HTTP headers/); expect(engine.start).not.toHaveBeenCalled(); runtime.shutdown();
  });
  it("explains ignored options and unavailable HTTP response instrumentation without leaking values", async () => {
    const { runtime } = setup(), onResponse = vi.fn();
    const result = await runtime.streamSimple(model(), context(), { ...opts, temperature: 0.3, maxTokens: 12, transport: "websocket",
      websocketConnectTimeoutMs: 3, thinkingBudgets: { low: 1 }, samplingParams: { top_p: 0.2 }, maxRetryDelayMs: 10,
      metadata: { secretFixtureValue: "not-for-diagnostics" }, onResponse }).result();
    expect(result.stopReason).toBe("stop"); expect(onResponse).not.toHaveBeenCalled();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "cursor_native_unsupported_options", details: expect.objectContaining({
      fields: expect.arrayContaining(["temperature", "maxTokens", "transport", "websocketConnectTimeoutMs", "thinkingBudgets", "samplingParams", "maxRetryDelayMs", "metadata"]),
    }) }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "cursor_native_transport", details: { onResponse: expect.stringContaining("unavailable") } }));
    expect(JSON.stringify(result.diagnostics)).not.toContain("not-for-diagnostics"); runtime.shutdown();
  });
});
