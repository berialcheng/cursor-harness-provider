import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createRustEngine, type RustEngine } from "@cursor-harness-provider/native";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCursorNative } from "../../packages/pi/src/index.js";
import { context, deferred, model } from "./fixtures.js";
import { piCursorServer } from "./cursor-server.js";
import { bounded, finishRustTurn, rustCursorServer, sendRustText } from "../opencode/fixtures/rust-cursor-server.js";
import { expireFixtureRecord, seedReleasedNativeRecord, snapshot } from "./operations-fixture.js";

const TOKEN = "mock-cursor-token";
// Mock only public host UI/context. Commands, runtime, loader, N-API and H2 are real.
// This is NOT actual CLI coverage; advanced-host.test.ts owns that separate proof.
function registered(root: string, url: string) {
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const events = new Map<string, (...args: any[]) => void>(), configs: ProviderConfig[] = [], engines: RustEngine[] = [];
  const env = { PI_CURSOR_SYSTEM_CREDENTIALS: "0", PI_CURSOR_AGENT_URL: url, PI_CURSOR_CACHE_DIR: root,
    PI_CURSOR_STREAM_IDLE_TIMEOUT_MS: "2500", PI_CURSOR_CONNECT_TIMEOUT_MS: "1000", PI_CURSOR_MAX_RETRIES: "0" };
  const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "operations-parent" },
    ui: { notify: vi.fn(), confirm: vi.fn(async () => true) }, modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: TOKEN }, env }) } };
  registerCursorNative({ registerProvider: (_id: string, config: ProviderConfig) => configs.push(config),
    registerCommand: (name: string, command: { handler: any }) => commands.set(name, command.handler),
    on: (name: string, fn: (...args: any[]) => void) => events.set(name, fn),
  } as unknown as ExtensionAPI, { env: () => env, createEngine: () => { const engine = createRustEngine(); engines.push(engine); return engine; } });
  events.get("session_start")!({}, ctx);
  const output = () => ctx.ui.notify.mock.calls.map(call => call[0]).join("\n");
  return { ctx, configs, engines, output,
    async command(name: string, args = "", commandContext = ctx) {
      ctx.ui.notify.mockClear(); await bounded(commands.get(name)!(args, commandContext as unknown as ExtensionCommandContext), name, 6000); return output();
    },
    stream(sessionId = "operations-parent", onPayload?: (payload: unknown) => Promise<unknown>) {
      return configs[0]!.streamSimple!(model(), context(), { apiKey: TOKEN, sessionId, ...(onPayload ? { onPayload } : {}) });
    },
    stop() { events.get("session_shutdown")!({}, ctx); },
  };
}
function scopeIn(output: string, kind = "chat"): string {
  const match = output.match(new RegExp(`([a-f0-9]{64}) model=auto kind=${kind} `));
  if (!match) throw new Error("Missing actual known scope: " + output); return match[1]!;
}

// No optional-method skip: this must fail against an old DSO until MAIN rebuilds it.
describe("registered recovery commands -> real Rust N-API (offline local H2)", () => {
  it("fences active and late work, preserves unrelated scope, rejects unknown/stale commands, and starts a new conversation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-operations-native-"))), server = await rustCursorServer();
    const h = registered(root, server.url);
    try {
      const active = h.stream(); await server.waitForRuns(1);
      const other = h.stream("operations-child"); await server.waitForRuns(2);
      const listing = await h.command("cursor.reset"), scope = scopeIn(listing), otherScope = scopeIn(listing, "child-chat");
      const oldConversation = server.runs[0]!.request.conversationId;
      const beforeUnknown = await snapshot(root);
      expect(await h.command("cursor.reset", `--scope ${"f".repeat(64)} --confirm-discard`)).toContain("Unknown scope");
      expect(await snapshot(root)).toEqual(beforeUnknown);
      expect(await h.command("cursor.reset", `--scope ${scope} --confirm-discard`)).toContain("Tool effects are not undone; no request retried");
      expect((await bounded(active.result(), "cancelled active result")).stopReason).toBe("aborted");
      expect((await h.command("cursor.reset"))).toContain(otherScope);
      finishRustTurn(server.runs[1]!.stream);
      expect((await bounded(other.result(), "unrelated scope result")).stopReason).toBe("stop");
      const fresh = h.stream(); await server.waitForRuns(3);
      expect(server.runs[2]!.request.conversationId).not.toBe(oldConversation);
      finishRustTurn(server.runs[2]!.stream); expect((await fresh.result()).stopReason).toBe("stop");
      const gate = deferred<unknown>(), entered = deferred<void>();
      const late = h.stream("operations-parent", async payload => { entered.resolve(); await gate.promise; return payload; });
      await bounded(entered.promise, "late payload entered");
      const scope2 = scopeIn(await h.command("cursor.reset"));
      await h.command("cursor.reset", `--scope ${scope2} --confirm-discard`);
      gate.resolve(undefined);
      expect((await bounded(late.result(), "late fenced result")).stopReason).toBe("aborted");
      expect(server.runs).toHaveLength(3); // late payload may not resurrect the removed actor.
      const beforeStale = await snapshot(root);
      const stale = { ...h.ctx, sessionManager: { getSessionId: () => "obsolete-parent" } };
      await h.command("cursor.reset", `--scope ${otherScope} --confirm-discard`, stale);
      expect(await snapshot(root)).toEqual(beforeStale);
      const again = h.stream(); await server.waitForRuns(4);
      expect(server.runs[3]!.request.conversationId).not.toBe(server.runs[2]!.request.conversationId);
      sendRustText(server.runs[3]!.stream, "new conversation"); finishRustTurn(server.runs[3]!.stream);
      expect((await again.result()).stopReason).toBe("stop");
      expect(h.ctx.ui.confirm.mock.calls.length).toBe(2);
      expect(server.errors).toEqual([]);
    } finally { h.stop(); await server.close(); await rm(root, { recursive: true, force: true }); }
  }, 25000);

  it("displays actual resource/cache report fields; dry run is byte/mode/mtime inert and apply is root-wide, retaining locked/corrupt records", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-operations-cache-"))), server = await piCursorServer();
    const h = registered(root, server.url), locked = createRustEngine();
    try {
      expect((await bounded(h.stream().result(), "seed registered runtime")).stopReason).toBe("stop");
      const scope = scopeIn(await h.command("cursor.reset")), directory = join(root, "pi", "rust-sessions-v1");
      const oldScope = "c".repeat(64), lockedScope = "d".repeat(64), corruptScope = "e".repeat(64);
      const input = (target: string) => JSON.stringify({ scope: target, modelId: "default", workspace: root, cacheDir: directory,
        agentUrl: server.url, stateless: false, maxRetries: 0, idleTimeoutMs: 2000, connectTimeoutMs: 1000,
        prompt: [{ role: "user", content: [{ type: "text", text: "TEMP_ONLY_NATIVE_CACHE_SEED" }] }], tools: [] });
      const drain = async (engine: RustEngine, target: string) => {
        const stream = await engine.start(input(target), TOKEN); let finish = false;
        for (let i = 0; i < 128; i++) { const raw = await bounded(stream.nextEvent(), "native seed event"); if (raw == null) break;
          const event = JSON.parse(raw); expect(event.type).not.toBe("error"); if (event.type === "finish") finish = true; }
        expect(finish).toBe(true);
      };
      await seedReleasedNativeRecord(input(oldScope));
      const reclaimableBytes = await expireFixtureRecord(join(directory, oldScope + ".bin"));
      await drain(locked, lockedScope);
      // Even an expired record must survive while a real native actor owns its lock.
      await expireFixtureRecord(join(directory, lockedScope + ".bin"));
      await writeFile(join(directory, corruptScope + ".bin"), "CORRUPT_FIXTURE_ONLY", { mode: 0o600 });
      await writeFile(join(directory, corruptScope + ".lock"), "", { mode: 0o600 });
      const lockedBefore = await readFile(join(directory, lockedScope + ".bin"));
      const before = await snapshot(directory);
      const engine = h.engines[0]!;
      expect(typeof engine.resourceStats).toBe("function"); expect(typeof engine.maintainCache).toBe("function");
      const resources = JSON.parse(engine.resourceStats!());
      const doctor = await h.command("cursor.doctor");
      const reported = JSON.parse(/^resources=(.+)$/m.exec(doctor)?.[1] ?? "null");
      for (const key of ["trackedBytes", "peakBytes", "limitBytes"]) {
        expect(resources[key]).toEqual(expect.any(Number)); expect(reported[key]).toEqual(expect.any(Number));
      }
      // Counters can change between snapshots as already-processed native frames drop.
      expect(reported.limitBytes).toBe(resources.limitBytes);
      expect(reported.trackedBytes).toBeGreaterThanOrEqual(0);
      expect(reported.trackedBytes).toBeLessThanOrEqual(reported.limitBytes);
      expect(reported.peakBytes).toBeGreaterThanOrEqual(resources.peakBytes);
      expect(reported.peakBytes).toBeGreaterThanOrEqual(reported.trackedBytes);
      expect(reported.rssBounded).toBe(false);
      const dry = await h.command("cursor.cache", `--scope ${scope}`);
      expect(dry).toContain(`scanned=4 skipped=3 expired=1 applied=0 reclaimableBytes=${reclaimableBytes}`);
      expect(dry).toContain("root-wide");
      expect(await snapshot(directory)).toEqual(before);
      const applied = await h.command("cursor.cache", `--scope ${scope} --apply --confirm-prune`);
      expect(applied).toContain(`scanned=4 skipped=3 expired=1 applied=1 reclaimableBytes=${reclaimableBytes}`);
      expect(await readFile(join(directory, oldScope + ".bin"), "utf8")).toBe("CURSREXP");
      expect(await readFile(join(directory, lockedScope + ".bin"))).toEqual(lockedBefore);
      expect(await readFile(join(directory, corruptScope + ".bin"), "utf8")).toBe("CORRUPT_FIXTURE_ONLY");
      expect(h.ctx.ui.confirm).toHaveBeenCalledOnce(); expect(server.errors).toEqual([]);
    } finally { h.stop(); locked.shutdown(); try { await server.close(); } finally { await rm(root, { recursive: true, force: true }); } }
  }, 20000);
});
