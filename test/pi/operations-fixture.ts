/** Offline acceptance helpers: only caller-owned temporary journals and public Pi RPC. */
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bounded } from "../opencode/fixtures/rust-cursor-server.js";

export async function snapshot(directory: string): Promise<unknown[]> {
  const result: unknown[] = [];
  const visit = async (path: string, name: string) => {
    const info = await lstat(path, { bigint: true });
    result.push([name, Number(info.mode), String(info.mtimeNs), info.isFile() ? (await readFile(path)).toString("hex") : null]);
    if (info.isDirectory()) for (const child of (await readdir(path)).sort()) await visit(join(path, child), name + "/" + child);
  };
  await visit(directory, "."); return result;
}
/** Preserve every native record field except updated and its SHA256 checksum. */
export async function expireFixtureRecord(path: string): Promise<number> {
  const data = await readFile(path);
  if (!["CURSRJ02", "CURSRJ03"].includes(data.subarray(0, 8).toString()) || data.readUInt32LE(8) !== 64) throw new Error("Not a fixture native journal");
  const conversationLength = data.readUInt32LE(108), updatedOffset = 112 + conversationLength;
  if (updatedOffset + 8 > data.length - 32) throw new Error("Invalid fixture journal header");
  data.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000) - 172800), updatedOffset);
  createHash("sha256").update(data.subarray(0, -32)).digest().copy(data, data.length - 32);
  await writeFile(path, data); return data.length - 8;
}

/** A separate process exits before callers age its journal, guaranteeing lock release. */
export async function seedReleasedNativeRecord(input: string): Promise<void> {
  const script = `import { createRustEngine } from "@cursor-harness-provider/native";
const input = JSON.parse(process.argv[1]);
if (new URL(input.agentUrl).hostname !== "127.0.0.1") throw new Error("Loopback fixture required");
const engine = createRustEngine(); let finished = false, ended = false;
try {
  const stream = await engine.start(JSON.stringify(input), "mock-cursor-token");
  for (let i = 0; i < 128; i++) {
    const raw = await stream.nextEvent(); if (raw == null) { ended = true; break; }
    const event = JSON.parse(raw); if (event.type === "error") throw new Error("Native fixture seed failed");
    if (event.type === "finish") finished = true;
  }
  if (!finished || !ended) throw new Error("Incomplete native fixture seed");
} finally { engine.shutdown(); }
`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, input],
    { cwd: process.cwd(), timeout: 6000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
}

export function piOperationsRpc(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const events: any[] = [], lines: string[] = [];
  let pending = "", stderr = "", exited = false, failure: Error | undefined, sequence = 0;
  const closed = new Promise<void>(resolve => { child.once("close", () => { exited = true; resolve(); }); });
  child.on("error", error => { failure = error; });
  child.stdin.on("error", error => { failure = error; });
  child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-20000); });
  child.stdout.on("data", data => {
    pending += String(data);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, ""); pending = pending.slice(newline + 1);
      lines.push(line);
      if (!line.trimStart().startsWith("{")) continue; // Headless command console output is not JSONL.
      try {
        const event = JSON.parse(line); events.push(event);
        if (event.type === "extension_ui_request" && event.method === "confirm") {
          // Accept only the two explicitly requested fixture operations, not arbitrary host dialogs.
          const allowed = /^(Discard Cursor recovery\?|Prune Cursor cache root-wide\?)$/.test(event.title);
          child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed: allowed }) + "\n");
        }
      } catch { /* A non-JSON console line is retained for command output assertions. */ }
    }
  });
  async function wait(predicate: () => boolean, label: string) {
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await bounded(new Promise<void>((resolve, reject) => {
        const check = () => {
          if (failure) reject(failure);
          else if (predicate()) resolve();
          else if (exited) reject(new Error("Pi RPC exited: " + stderr + lines.slice(-20).join("\n")));
        };
        timer = setInterval(check, 10); check();
      }), label, 20000);
    } catch (error) { throw new Error(String(error) + "\n" + stderr + "\n" + lines.slice(-30).join("\n")); }
    finally { clearInterval(timer); }
  }
  return {
    async prompt(message: string, normal = false): Promise<string> {
      const id = "operations-" + ++sequence, start = events.length, lineStart = lines.length;
      child.stdin.write(JSON.stringify({ type: "prompt", id, message }) + "\n");
      await wait(() => events.slice(start).some(e => e.type === "response" && e.id === id), "Pi RPC command " + message);
      const response = events.slice(start).find(e => e.type === "response" && e.id === id);
      if (!response.success) throw new Error("Pi RPC rejected command: " + JSON.stringify(response));
      if (normal) {
        await wait(() => events.slice(start).some(e => e.type === "agent_end"), "Pi RPC agent_end");
        const assistants = events.slice(start).filter(e => e.type === "message_end" && e.message?.role === "assistant");
        if (!assistants.length || assistants.at(-1).message.stopReason !== "stop") throw new Error("Pi RPC failed native turn: " + JSON.stringify(assistants));
      }
      return lines.slice(lineStart).join("\n") + "\n" + events.slice(start).filter(e => e.type === "extension_ui_request" && e.method === "notify").map(e => e.message).join("\n");
    },
    async close() {
      child.stdin.end();
      try { await bounded(closed, "Pi RPC orderly shutdown", 4000); }
      catch { child.kill("SIGKILL"); await bounded(closed, "Pi RPC forced shutdown", 3000); }
    },
  };
}
