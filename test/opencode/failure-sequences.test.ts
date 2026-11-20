import { describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { McpArgsSchema } from "../reference/pi-cursor/src/proto/agent_pb.js";
import { bounded, finishRustTurn, rustCursorServer, sendRustExec, sendRustText, type RustCursorRun } from "./fixtures/rust-cursor-server.js";

// These test real process death, NOT power-loss durability or ENOSPC/EIO.
// Journals currently require Linux/macOS descriptor-relative filesystem support.
const supported = process.platform === "linux" || process.platform === "darwin";
if (!supported && (process.env.CURSOR_NATIVE_REQUIRE_FAILURE_SEQUENCES === "1" || process.env.OPENCODE_CURSOR_REQUIRE_HOST === "1")) {
  throw new Error("Required native failure-sequence tests need Linux/macOS; refusing to skip");
}
interface Packet {
  kind: string; id?: number; ok?: boolean; error?: string; type?: string;
  finishReason?: { unified: string; raw?: string }; toolCallId?: string; toolName?: string; providerExecuted?: boolean;
}
class NativeProcess {
  readonly child: ChildProcess;
  readonly packets: Packet[] = [];
  readonly changed = new EventEmitter();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private next = 0;
  private dead = false;
  private diagnostics = 0;
  constructor(directory: string) {
    this.child = fork(fileURLToPath(new URL("./fixtures/native-process.mjs", import.meta.url)), [], {
      execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Do not inherit auth, proxies, NODE_OPTIONS or the user's home/config.
      env: {
        HOME: directory, TMPDIR: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
        CURSOR_CONFIG_DIR: join(directory, "config"), CURSOR_NATIVE_CACHE_DIR: directory,
        OPENCODE_CURSOR_CACHE_DIR: directory, PI_CURSOR_CACHE_DIR: directory,
        OPENCODE_CURSOR_OFFLINE: "1", CURSOR_DEBUG: "0", OPENCODE_CURSOR_PROVIDER_DEBUG: "0",
        OPENCODE_CURSOR_AGENT_URL: "http://127.0.0.1:9", CURSOR_AGENT_URL: "http://127.0.0.1:9",
        PI_CURSOR_AGENT_URL: "http://127.0.0.1:9", NO_PROXY: "*", no_proxy: "*",
        ...(process.env.CURSOR_NATIVE_LIBC ? { CURSOR_NATIVE_LIBC: process.env.CURSOR_NATIVE_LIBC } : {}),
      },
    });
    // Discard diagnostics; never forward raw native output to test logs.
    this.child.stdout!.on("data", bytes => { this.diagnostics += bytes.length; });
    this.child.stderr!.on("data", bytes => { this.diagnostics += bytes.length; });
    this.child.on("message", message => { this.packets.push(message as Packet); this.changed.emit("change"); });
    this.child.on("error", () => { this.dead = true; this.changed.emit("change"); });
    this.exited = new Promise(resolve => this.child.once("exit", (code, signal) => {
      this.dead = true; this.changed.emit("change"); resolve({ code, signal });
    }));
  }
  async wait(predicate: (packet: Packet) => boolean): Promise<Packet> {
    let wake!: () => void;
    const changed = () => wake();
    try {
      return await bounded((async () => {
        while (true) {
          const packet = this.packets.find(predicate);
          if (packet) return packet;
          if (this.dead) throw new Error("Native fixture exited before expected IPC response");
          await new Promise<void>(resolve => { wake = resolve; this.changed.once("change", changed); });
        }
      })(), "native child IPC", 3500);
    } finally { this.changed.off("change", changed); }
  }
  async command(op: string, fields: Record<string, unknown> = {}) {
    const id = ++this.next;
    if (!this.child.connected) throw new Error("Native child IPC disconnected");
    this.child.send({ id, op, ...fields });
    const reply = await this.wait(packet => packet.kind === "reply" && packet.id === id);
    return { id, ...reply };
  }
  async start(input: Record<string, unknown>) { return this.command("start", { input }); }
  events(id: number) { return this.packets.filter(packet => packet.id === id && packet.kind === "event"); }
  async end(id: number) { return this.wait(packet => packet.id === id && packet.kind === "end"); }
  async kill() {
    const wasAlive = !this.dead;
    if (wasAlive) this.child.kill("SIGKILL");
    const exit = await bounded(this.exited, "SIGKILL child reap", 3500);
    if (wasAlive) expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(this.diagnostics, "native child must not log raw diagnostics").toBe(0);
  }
}
async function scenario(options: Parameters<typeof rustCursorServer>[0], body: (context: {
  directory: string; scope: string; server: Awaited<ReturnType<typeof rustCursorServer>>;
  child: () => Promise<NativeProcess>; input: Record<string, unknown>; journal: string;
}) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cursor-native-faults-")));
  const children: NativeProcess[] = [];
  let server: Awaited<ReturnType<typeof rustCursorServer>> | undefined;
  try {
    server = await rustCursorServer(options);
    const scope = randomBytes(32).toString("hex");
    const input = { scope, modelId: "auto", workspace: directory, cacheDir: directory, agentUrl: server.url,
      stateless: false, maxRetries: 0, idleTimeoutMs: 2500, connectTimeoutMs: 1000,
      prompt: [{ role: "user", content: [{ type: "text", text: "synthetic fault fixture" }] }],
    };
    await body({ directory, scope, server, input, journal: join(directory, scope + ".bin"),
      child: async () => {
        const child = new NativeProcess(directory); children.push(child);
        await child.wait(packet => packet.kind === "ready"); return child;
      },
    });
  } finally {
    // Reap every independent native process before closing servers/removing caches,
    // including failed startups and failed assertions. Cleanup steps all run.
    const cleanup = await Promise.allSettled(children.map(child => child.kill()));
    try { if (server) { await server.close(); expect(server.errors.length).toBe(0); } }
    finally { await rm(directory, { recursive: true, force: true }); }
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
  }
}
async function success(child: NativeProcess, input: Record<string, unknown>) {
  const started = await child.start(input);
  expect(started.ok).toBe(true);
  expect((await child.end(started.id)).error).toBeUndefined();
  const events = child.events(started.id);
  expect(events.some(event => event.type === "error" || event.type === "tool-call")).toBe(false);
  expect(events.filter(event => event.type === "text-delta")).toHaveLength(1);
  expect(events.filter(event => event.type === "finish")).toMatchObject([{ finishReason: { unified: "stop" } }]);
}
const reply = ({ stream }: RustCursorRun) => {
  sendRustText(stream, "action-free fixture reply"); finishRustTurn(stream);
};

describe.skipIf(!supported)("real native POSIX process failure sequences (localhost H2, synthetic auth)", () => {
  it("excludes an independent journal contender, then SIGKILL releases ownership for action-free restart", async () => {
    let runs = 0;
    await scenario({ onRun: run => { if (++runs > 1) reply(run); } }, async ({ child, input, server, journal }) => {
      const holder = await child(), contender = await child();
      const held = await holder.start(input); expect(held.ok).toBe(true);
      const [first] = await server.waitForRuns(1);
      await holder.wait(packet => packet.id === held.id && packet.type === "response-metadata");
      expect((await readFile(journal)).length).toBeGreaterThan(8);
      const refused = await contender.start(input);
      expect(refused).toMatchObject({ ok: false, error: "locked" });
      expect(server.runs).toHaveLength(1);
      expect(server.connections).toBe(1);
      expect(server.activeStreams).toBe(1);
      await holder.kill(); await bounded(first!.closed, "killed holder H2 close");
      await success(contender, input);
      expect(server.runs).toHaveLength(2);
      expect(server.runs[1]!.request.conversationId).not.toBe(first!.request.conversationId);
      expect(server.messages.filter(message => message.message.case === "execClientMessage").length).toBe(0);
    });
  }, 15000);

  it("kills after a durable exposed tool call; absent host-result proof cannot replay, emit another tool or finish", async () => {
    let runs = 0;
    await scenario({ onRun: run => {
      if (++runs > 1) { reply(run); return; }
      // Only an explicit synthetic host gate is registered. Native cannot execute it.
      sendRustExec(run.stream, 71, { case: "mcpArgs", value: create(McpArgsSchema, {
        name: "mcp_pi_fault_gate", toolName: "fault_gate", providerIdentifier: "pi", toolCallId: "durable-call-71",
      }) }, "synthetic-gate-exec");
    } }, async ({ child, input, scope, server, journal }) => {
      const tools = [{ type: "function", name: "fault_gate", inputSchema: { type: "object", properties: {} } }];
      const request = { ...input, tools }, holder = await child();
      const started = await holder.start(request); expect(started.ok).toBe(true);
      const call = await holder.wait(packet => packet.id === started.id && packet.type === "tool-call");
      expect(call).toMatchObject({ toolCallId: "durable-call-71", toolName: "fault_gate", providerExecuted: false });
      const durable = await readFile(journal);
      expect(durable.includes(Buffer.from("durable-call-71"))).toBe(true);
      await holder.kill();
      await bounded(server.runs[0]!.closed, "killed tool holder H2 close");
      // A final normal commit may race SIGKILL; do not require byte identity.
      expect((await readFile(journal)).includes(Buffer.from("durable-call-71"))).toBe(true);
      const restarted = await child();
      // Original history, then assistant-call-only history: neither proves execution.
      for (const prompt of [input.prompt, [...input.prompt as unknown[], {
        role: "assistant", content: [{ type: "tool-call", toolCallId: "durable-call-71", toolName: "fault_gate", input: {} }],
      }]]) {
        const attempt = await restarted.start({ ...request, prompt });
        if (attempt.ok) {
          const ended = await restarted.end(attempt.id), events = restarted.events(attempt.id);
          expect(events.some(event => event.type === "error" && event.error === "unsafe") || ended.error === "unsafe").toBe(true);
          expect(events.some(event => event.type === "tool-call" || event.type === "finish")).toBe(false);
        } else expect(attempt.error).toBe("unsafe");
        expect(server.runs).toHaveLength(1); // Positive terminal IPC barrier, not a sleep.
        expect(server.connections).toBe(1);
        expect(server.messages.filter(message => message.message.case === "execClientMessage").length).toBe(0);
      }
      expect((await restarted.command("remove", { scope })).ok).toBe(true);
      await expect(access(journal)).rejects.toMatchObject({ code: "ENOENT" });
      await success(restarted, request); // Explicit reset only; never implicit replay.
      expect(server.runs).toHaveLength(2);
    });
  }, 15000);

  it.each(["corrupt", "truncated"] as const)("rejects a %s journal before upstream, then explicit remove permits restart", async kind => {
    await scenario({ onRun: reply }, async ({ child, input, scope, server, journal }) => {
      const writer = await child(); await success(writer, input); await writer.kill();
      const bytes = await readFile(journal);
      const damaged = kind === "truncated" ? bytes.subarray(0, Math.min(16, bytes.length - 1)) : Buffer.from(bytes);
      if (kind === "corrupt") damaged[0] = damaged[0]! ^ 0xff;
      await writeFile(journal, damaged, { mode: 0o600 });
      const reader = await child(), connections = server.connections;
      expect(await reader.start(input)).toMatchObject({ ok: false, error: "corrupt" });
      expect(server.runs).toHaveLength(1); expect(server.connections).toBe(connections);
      expect(await readFile(journal)).toEqual(damaged);
      expect((await reader.command("remove", { scope })).ok).toBe(true);
      await expect(access(journal)).rejects.toMatchObject({ code: "ENOENT" });
      await success(reader, input); expect(server.runs).toHaveLength(2);
    });
  }, 15000);

  it("cancels an action-free stream, restarts the scope, removes it and starts in a fresh process", async () => {
    let runs = 0;
    await scenario({ onRun: run => { if (++runs > 1) reply(run); } }, async ({ child, input, scope, server, journal }) => {
      const owner = await child(), started = await owner.start(input); expect(started.ok).toBe(true);
      const [first] = await server.waitForRuns(1);
      expect((await owner.command("cancel", { run: started.id })).ok).toBe(true);
      await owner.end(started.id); await bounded(first!.closed, "cancel H2 close");
      expect(owner.events(started.id).some(event => event.type === "finish" || event.type === "tool-call")).toBe(false);
      await success(owner, input);
      expect(server.runs[1]!.request.conversationId).not.toBe(first!.request.conversationId);
      expect((await owner.command("remove", { scope })).ok).toBe(true);
      await expect(access(journal)).rejects.toMatchObject({ code: "ENOENT" });
      await owner.kill();
      const restarted = await child(); await success(restarted, input);
      expect(server.runs).toHaveLength(3);
      expect(server.runs[2]!.request.conversationId).not.toBe(server.runs[1]!.request.conversationId);
      expect(server.messages.filter(message => message.message.case === "execClientMessage").length).toBe(0);
    });
  }, 15000);
});
