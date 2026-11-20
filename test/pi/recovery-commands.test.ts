import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { registerCursorNative } from "../../packages/pi/src/index.js";

const { Runtime, runtimes } = vi.hoisted(() => {
  class Runtime {
    closed = false;
    session?: { sessionId: string; workspace: string };
    scopes = [{ scope: "a".repeat(64), modelId: "fixture-model", kind: "chat", state: "uncertain", activeRequests: 0, pendingStart: false, mayHaveActions: true }];
    constructor() { runtimes.push(this); }
    get isClosed() { return this.closed; }
    setSession(identity: { sessionId: string; workspace: string }) { this.session = identity; }
    ownsSession = vi.fn((id: string, cwd: string) => !this.closed && this.session?.sessionId === id && this.session.workspace === cwd);
    recoveryScopes = vi.fn(() => this.scopes.map(item => ({ ...item })));
    resetScope = vi.fn(async (_scope: string, _signal?: AbortSignal): Promise<void> => {});
    maintainCache = vi.fn(async (_scope: string, apply: boolean, _signal?: AbortSignal): Promise<unknown> => ({ scanned: 5, skipped: 2, expired: 2, applied: apply ? 2 : 0, reclaimableBytes: 1024 }));
    definitions = vi.fn(() => [{ id: "fixture-model", name: "Fixture", input: ["text"] }]);
    doctor = vi.fn(() => "fixture diagnostic; no live request");
    usage = vi.fn(async (_token?: string, _signal?: AbortSignal, _env?: Record<string, string>) => ({ used: 2 }));
    streamSimple = vi.fn();
    refreshModels = vi.fn(async () => this.definitions());
    shutdown = vi.fn(() => { this.closed = true; });
  }
  const runtimes: Runtime[] = [];
  return { Runtime, runtimes };
});
// Keep these tests about command ownership/UI, independent of native builds.
vi.mock("../../packages/pi/src/runtime.js", () => ({ PiRustRuntime: Runtime }));

const scope = "a".repeat(64), otherScope = "b".repeat(64);
type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
const cleanups: Array<() => void> = [];
function harness(hasUI = true, start = true) {
  const commands = new Map<string, Handler>();
  const events = new Map<string, (...args: any[]) => void>();
  const configs: ProviderConfig[] = [];
  const ctx = {
    hasUI, cwd: "/tmp/cursor-recovery-fixture", signal: undefined as AbortSignal | undefined,
    sessionManager: { getSessionId: vi.fn(() => "session-a") },
    ui: { notify: vi.fn(),
      confirm: vi.fn(async (_title: string, _message: string, _options?: { signal?: AbortSignal }) => true),
      select: vi.fn(async (_title: string, _options: string[], _dialog?: { signal?: AbortSignal }): Promise<string | undefined> => undefined) },
    modelRegistry: {
      getProviderAuth: vi.fn(async () => ({ auth: { apiKey: "fixture-only-key" }, env: {} })),
      refresh: vi.fn(async () => ({ errors: new Map<string, Error>(), aborted: false })),
    },
  };
  registerCursorNative({
    registerProvider: (_id: string, config: ProviderConfig) => { configs.push(config); },
    registerCommand: (name: string, command: { handler: Handler }) => { commands.set(name, command.handler); },
    on: (event: string, fn: (...args: any[]) => void) => { events.set(event, fn); },
  } as unknown as ExtensionAPI, { env: () => ({ PI_CURSOR_SYSTEM_CREDENTIALS: "0" }) });
  const begin = (context = ctx) => events.get("session_start")!({}, context);
  const stop = () => events.get("session_shutdown")!({}, ctx);
  cleanups.push(stop);
  if (start) begin();
  const runtime = runtimes.at(-1)!;
  const run = (name: string, args = "", context = ctx) => commands.get(name)!(args, context as unknown as ExtensionCommandContext);
  return { ctx, runtime, run, begin, stop, configs };
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  runtimes.splice(0);
  vi.restoreAllMocks();
});

describe("Cursor safe recovery commands (public host UI; fixture-only runtime)", () => {
  it("no args/help list exact scopes without auth, UI prompts, pruning, or reset", async () => {
    const h = harness();
    for (const name of ["cursor.reset", "cursor.cache"]) {
      await h.run(name);
      await h.run(name, "--help");
    }
    expect(h.ctx.ui.notify.mock.calls.flat().join(" ")).toContain(scope);
    expect(h.ctx.ui.notify.mock.calls.flat().join(" ")).toContain("mayHaveActions=true");
    const help = h.ctx.ui.notify.mock.calls.flat().join(" ");
    expect(help).toContain("headless --apply --confirm-prune explicitly confirms root-wide pruning");
    expect(help).toContain("known scope supplies the known cache root, not a scope-only filter");
    expect(help).toContain("other expired records, including other conversations in that root");
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled(); expect(h.ctx.ui.select).not.toHaveBeenCalled();
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(h.runtime.maintainCache).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled(); expect(h.ctx.modelRegistry.refresh).not.toHaveBeenCalled();
  });
  it.each(["cursor.reset", "cursor.cache"])("%s selection cancellation and declined confirmation never mutate", async name => {
    const h = harness();
    await h.run(name, "--select" + (name === "cursor.cache" ? " --apply" : ""));
    h.ctx.ui.select.mockResolvedValue(scope); h.ctx.ui.confirm.mockResolvedValue(false);
    await h.run(name, "--select" + (name === "cursor.cache" ? " --apply" : ""));
    expect(h.ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(h.runtime.maintainCache).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });
  it("UI reset confirms that effects are not undone and resets only the selected full scope", async () => {
    const h = harness();
    h.ctx.ui.select.mockResolvedValue(scope);
    await h.run("cursor.reset", "--select");
    expect(h.ctx.ui.select.mock.calls[0]![1]).toEqual([scope]);
    expect(h.ctx.ui.confirm.mock.calls[0]![1]).toMatch(/Tools may already have effects.*not undo/s);
    expect(h.runtime.resetScope).toHaveBeenCalledExactlyOnceWith(scope, undefined);
    expect(h.runtime.maintainCache).not.toHaveBeenCalled(); expect(h.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });
  it.each([otherScope, scope.slice(0, 8), "../cache", scope.toUpperCase()])("denies unknown or non-exact scope %s", async value => {
    const h = harness();
    await h.run("cursor.reset", `--scope ${value} --confirm-discard`);
    await h.run("cursor.cache", `--scope ${value} --apply --confirm-prune`);
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(h.runtime.maintainCache).not.toHaveBeenCalled();
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it("denies a selector value not offered by the runtime", async () => {
    const h = harness(); h.ctx.ui.select.mockResolvedValue(otherScope);
    await h.run("cursor.reset", "--select");
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it("requires explicit full-scope confirmation flags in headless mode", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(false);
    await h.run("cursor.reset", `--scope ${scope}`);
    await h.run("cursor.cache", `--scope ${scope} --apply`);
    await h.run("cursor.reset", "--confirm-discard");
    await h.run("cursor.cache", "--apply --confirm-prune");
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(h.runtime.maintainCache).not.toHaveBeenCalled();
    await h.run("cursor.reset", `--scope ${scope} --confirm-discard`);
    await h.run("cursor.cache", `--scope ${scope} --apply --confirm-prune`);
    expect(h.runtime.resetScope).toHaveBeenCalledExactlyOnceWith(scope, undefined);
    expect(h.runtime.maintainCache).toHaveBeenCalledExactlyOnceWith(scope, true, undefined);
    expect(errors.mock.calls.flat().join(" ")).toContain("Headless root-wide pruning requires --scope to supply the known root");
    expect(log.mock.calls.flat().join(" ")).toContain("root-wide apply completed");
    expect(log.mock.calls.flat().join(" ")).toContain("other expired records, including other conversations in that root");
    expect(log.mock.calls.flat().join(" ")).toContain("scanned=5 skipped=2 expired=2 applied=2 reclaimableBytes=1024");
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });
  it("headless dry run needs no confirmation; malformed flags cannot broaden the target", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(false);
    await h.run("cursor.cache", `--scope ${scope}`);
    expect(h.runtime.maintainCache).toHaveBeenCalledExactlyOnceWith(scope, false, undefined);
    for (const args of ["--apply", `--scope ${scope} --confirm-prune`, `--scope ${scope} --scope ${otherScope} --apply --confirm-prune`, "--all --apply --confirm-prune", "--select --apply"]) {
      await h.run("cursor.cache", args);
    }
    expect(h.runtime.maintainCache).toHaveBeenCalledOnce(); expect(h.runtime.resetScope).not.toHaveBeenCalled();
  });
  it("cache defaults to dry run, reports counts, and requires UI confirmation for apply", async () => {
    const h = harness();
    await h.run("cursor.cache", `--scope ${scope}`);
    expect(h.runtime.maintainCache).toHaveBeenNthCalledWith(1, scope, false, undefined);
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
    await h.run("cursor.cache", `--scope ${scope} --apply`);
    expect(h.runtime.maintainCache).toHaveBeenNthCalledWith(2, scope, true, undefined);
    expect(h.ctx.ui.confirm.mock.calls[0]![0]).toContain("root-wide");
    const confirmation = h.ctx.ui.confirm.mock.calls[0]![1];
    expect(confirmation).toContain(`Known root anchored by scope ${scope}`);
    expect(confirmation).toContain("known scope supplies the known cache root, not a scope-only filter");
    expect(confirmation).toContain("other expired records, including other conversations in that root");
    expect(confirmation).toContain("Locked, active, or corrupt records are skipped");
    expect(confirmation).toContain("all uncertainty tombstones are retained");
    expect(confirmation).toContain("No actions are undone; no DSO/library cleanup");
    const messages = h.ctx.ui.notify.mock.calls.flat().join(" ");
    expect(messages).toContain("root-wide dry run completed");
    expect(messages).toContain("root-wide apply completed");
    expect(messages).toContain("scanned=5 skipped=2 expired=2 applied=0 reclaimableBytes=1024");
    expect(messages).toContain("scanned=5 skipped=2 expired=2 applied=2 reclaimableBytes=1024");
    expect(messages).toContain("other expired records, including other conversations in that root");
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(h.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });
  it.each(["cursor.reset", "cursor.cache", "cursor.models", "cursor.doctor", "cursor.usage"])("%s rejects other session/workspace and unstarted owners before any work", async name => {
    const h = harness(true, false);
    await h.run(name, "--scope " + scope);
    h.begin();
    const other = { ...h.ctx, sessionManager: { getSessionId: vi.fn(() => "session-b") } };
    await h.run(name, "--scope " + scope, other);
    await h.run(name, "--scope " + scope, { ...h.ctx, cwd: "/tmp/other-workspace" });
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(h.runtime.maintainCache).not.toHaveBeenCalled();
    expect(h.runtime.doctor).not.toHaveBeenCalled(); expect(h.runtime.usage).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled(); expect(h.ctx.modelRegistry.refresh).not.toHaveBeenCalled();
  });
  it.each(["cursor.reset", "cursor.cache"])("%s denies confirmation after same-ID lifecycle replacement", async name => {
    const h = harness(), confirm = pending<boolean>();
    h.ctx.ui.confirm.mockReturnValue(confirm.promise);
    const command = h.run(name, `--scope ${scope}` + (name === "cursor.cache" ? " --apply --confirm-prune" : " --confirm-discard"));
    expect(h.ctx.ui.confirm).toHaveBeenCalledOnce();
    h.stop(); h.begin(); const replacement = runtimes.at(-1)!;
    confirm.resolve(true); await command;
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(h.runtime.maintainCache).not.toHaveBeenCalled();
    expect(replacement.resetScope).not.toHaveBeenCalled(); expect(replacement.maintainCache).not.toHaveBeenCalled();
    expect(h.configs).toHaveLength(2);
    const provenance = (config: ProviderConfig) => (config.models![0]! as unknown as Record<string, unknown>).cursorNativeCompatOwner;
    expect(provenance(h.configs[1]!)).toEqual(expect.any(String));
    expect(provenance(h.configs[1]!)).not.toBe(provenance(h.configs[0]!));
  });
  it("rejects lifecycle replacement during scope selection before even asking for confirmation", async () => {
    const h = harness(), selection = pending<string | undefined>();
    h.ctx.ui.select.mockReturnValueOnce(selection.promise);
    const command = h.run("cursor.reset", "--select");
    h.stop(); h.begin(); selection.resolve(scope); await command;
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(h.runtime.resetScope).not.toHaveBeenCalled(); expect(runtimes.at(-1)!.resetScope).not.toHaveBeenCalled();
  });
  it("rechecks ownership after cache/reset completion and never reports success into a replacement", async () => {
    const h = harness(), reset = pending<void>();
    h.runtime.resetScope.mockReturnValueOnce(reset.promise);
    const command = h.run("cursor.reset", `--scope ${scope}`);
    // The confirmation itself is asynchronous; let its continuation dispatch.
    await Promise.resolve();
    expect(h.runtime.resetScope).toHaveBeenCalledOnce();
    h.stop(); h.begin(); reset.resolve(); await command;
    expect(h.ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("recovery discarded for");
    const current = runtimes.at(-1)!, cache = pending<unknown>();
    current.maintainCache.mockReturnValueOnce(cache.promise);
    const command2 = h.run("cursor.cache", `--scope ${scope}`);
    h.stop(); h.begin(); cache.resolve({ scanned: 1 }); await command2;
    expect(h.ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("dry run completed");
    expect(runtimes.at(-1)!.maintainCache).not.toHaveBeenCalled();
  });
  it("rechecks scope existence after confirmation and cancellation after awaiting UI", async () => {
    const h = harness(), confirm = pending<boolean>();
    h.ctx.ui.confirm.mockReturnValueOnce(confirm.promise);
    const command = h.run("cursor.reset", `--scope ${scope}`);
    h.runtime.scopes = []; confirm.resolve(true); await command;
    expect(h.runtime.resetScope).not.toHaveBeenCalled();
    const cancel = new AbortController(); h.ctx.signal = cancel.signal;
    h.runtime.scopes = [{ scope, modelId: "fixture", kind: "chat", state: "uncertain", activeRequests: 0, pendingStart: false, mayHaveActions: true }];
    const confirm2 = pending<boolean>(); h.ctx.ui.confirm.mockReturnValueOnce(confirm2.promise);
    const command2 = h.run("cursor.cache", `--scope ${scope} --apply`);
    cancel.abort(); confirm2.resolve(true); await command2;
    expect(h.runtime.maintainCache).not.toHaveBeenCalled();
  });
  it("pre-aborted commands never prompt or dispatch; stale contexts never use replacement runtime", async () => {
    const h = harness(), cancel = new AbortController(); cancel.abort(); h.ctx.signal = cancel.signal;
    await h.run("cursor.reset", `--scope ${scope}`);
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled(); expect(h.runtime.resetScope).not.toHaveBeenCalled();
    h.ctx.signal = undefined; h.stop();
    h.begin({ ...h.ctx, sessionManager: { getSessionId: vi.fn(() => "session-b") } });
    const replacement = runtimes.at(-1)!;
    await h.run("cursor.reset", `--scope ${scope} --confirm-discard`);
    expect(replacement.resetScope).not.toHaveBeenCalled(); expect(h.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });
  it("sanitizes failures and never prints arbitrary native report payloads", async () => {
    const h = harness();
    h.runtime.resetScope.mockRejectedValueOnce(new Error("authorization=fixture-secret Bearer hidden"));
    await h.run("cursor.reset", `--scope ${scope}`);
    h.runtime.maintainCache.mockResolvedValueOnce({ scanned: 5, skipped: 1, expired: 2, applied: 0, reclaimableBytes: 512, token: "private-native-payload", unknownCount: 99 });
    await h.run("cursor.cache", `--scope ${scope}`);
    const messages = h.ctx.ui.notify.mock.calls.flat().join(" ");
    expect(messages).toContain("[REDACTED]"); expect(messages).not.toMatch(/fixture-secret|hidden|private-native-payload|unknownCount/);
    expect(messages).toContain("scanned=5 skipped=1 expired=2 applied=0 reclaimableBytes=512");
    expect(h.runtime.resetScope).toHaveBeenCalledOnce();
  });
  it("formats only finite numeric native counts, including JSON reports", async () => {
    const h = harness();
    h.runtime.maintainCache.mockResolvedValueOnce(JSON.stringify({ scanned: 4, skipped: 1, expired: 2, applied: 0, reclaimableBytes: 256, secret: "fixture-report-secret", unknownCount: 99 }));
    await h.run("cursor.cache", `--scope ${scope}`);
    expect(h.ctx.ui.notify.mock.calls.flat().join(" ")).toContain("scanned=4 skipped=1 expired=2 applied=0 reclaimableBytes=256");
    h.runtime.maintainCache.mockResolvedValueOnce({ scanned: Infinity, skipped: NaN, expired: "fixture-report-secret", applied: {}, reclaimableBytes: -Infinity });
    await h.run("cursor.cache", `--scope ${scope}`);
    const messages = h.ctx.ui.notify.mock.calls.map(call => call[0]);
    expect(messages.join(" ")).not.toMatch(/fixture-report-secret|unknownCount|Infinity|NaN/);
    expect(messages[1]).not.toMatch(/scanned=|skipped=|expired=|applied=|reclaimableBytes=/);
    // Keep an explicitly boolean apply indicator visible too, without accepting arbitrary booleans.
    h.runtime.maintainCache.mockResolvedValueOnce({ scanned: 1, skipped: 0, expired: 0, applied: false, reclaimableBytes: 0, unknownFlag: true });
    await h.run("cursor.cache", `--scope ${scope}`);
    const booleanReport = h.ctx.ui.notify.mock.calls.at(-1)![0];
    expect(booleanReport).toContain("scanned=1 skipped=0 expired=0 applied=false reclaimableBytes=0");
    expect(booleanReport).not.toContain("unknownFlag");
  });
  it("headless confirmation flags cannot bypass a stale owner", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness(false);
    h.stop(); h.begin({ ...h.ctx, sessionManager: { getSessionId: vi.fn(() => "session-b") } });
    await h.run("cursor.cache", `--scope ${scope} --apply --confirm-prune`);
    await h.run("cursor.reset", `--scope ${scope} --confirm-discard`);
    expect(h.runtime.maintainCache).not.toHaveBeenCalled(); expect(h.runtime.resetScope).not.toHaveBeenCalled();
    expect(runtimes.at(-1)!.maintainCache).not.toHaveBeenCalled(); expect(runtimes.at(-1)!.resetScope).not.toHaveBeenCalled();
  });
  it("doctor is credential/live noop, cached models stay local, discovery still uses host refresh", async () => {
    const h = harness();
    await h.run("cursor.doctor"); await h.run("cursor.models", "--cached");
    expect(h.runtime.doctor).toHaveBeenCalledOnce(); expect(h.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
    expect(h.ctx.modelRegistry.refresh).not.toHaveBeenCalled();
    await h.run("cursor.models");
    expect(h.ctx.modelRegistry.refresh).toHaveBeenCalledExactlyOnceWith({ providers: ["cursor"], allowNetwork: true, force: true, signal: undefined });
    await h.run("cursor.usage");
    expect(h.ctx.modelRegistry.getProviderAuth).toHaveBeenCalledExactlyOnceWith("cursor");
    expect(h.runtime.usage).toHaveBeenCalledExactlyOnceWith("fixture-only-key", undefined, {});
  });
  it("usage auth and model refresh continuations cannot borrow a replacement parent", async () => {
    const h = harness(), auth = pending<{ auth: { apiKey: string }; env: {} }>();
    h.ctx.modelRegistry.getProviderAuth.mockReturnValueOnce(auth.promise);
    const command = h.run("cursor.usage"); h.stop(); h.begin();
    auth.resolve({ auth: { apiKey: "fixture-replaced-key" }, env: {} }); await command;
    expect(h.runtime.usage).not.toHaveBeenCalled(); expect(runtimes.at(-1)!.usage).not.toHaveBeenCalled();
    const refresh = pending<{ errors: Map<string, Error>; aborted: boolean }>();
    h.ctx.modelRegistry.refresh.mockReturnValueOnce(refresh.promise);
    const discovery = h.run("cursor.models"); h.stop(); h.begin();
    const replacement = runtimes.at(-1)!; replacement.definitions.mockClear();
    refresh.resolve({ errors: new Map(), aborted: false }); await discovery;
    expect(replacement.definitions).not.toHaveBeenCalled();
  });
});
