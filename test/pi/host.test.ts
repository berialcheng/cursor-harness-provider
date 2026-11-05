import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { cursorServer } from "../opencode/fixtures/cursor-server.js";
const run = promisify(execFile);
const requestedBinary = process.env.CURSOR_NATIVE_PI_BINARY ?? "pi";
const binary = requestedBinary.includes("/") && !isAbsolute(requestedBinary) ? resolve(requestedBinary) : requestedBinary;
const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
const available = version.status === 0 && /\b1\.[45]\.0\b/.test(version.stdout);
if (process.env.CURSOR_NATIVE_REQUIRE_PI === "1" && !available) throw new Error("Required actual Pi1.4/1.5 host unavailable");
const extension = process.env.CURSOR_PACKED_PI_EXTENSION ?? fileURLToPath(new URL("../../packages/pi/dist/index.js", import.meta.url));
if (!isAbsolute(extension)) throw new Error("Pi test extension must be absolute");

async function hostCase(kind: "text" | "read" | "denied") {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "cursor-native-pi-host-")));
  const agentDir = join(profile, "agent");
  await mkdir(agentDir);
  const file = join(profile, "fixture.txt");
  await writeFile(file, "PI_HOST_PERMISSION_MARKER");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }));
  const probe = join(profile, "probe.ts");
  await writeFile(probe, `import cursor from ${JSON.stringify(extension)};
export default function(pi) {
  cursor(pi);
  pi.on("tool_call", (e) => {
    if (e.toolName !== "read" || e.input.path !== ${JSON.stringify(file)} || ${JSON.stringify(kind)} !== "read")
      return { block: true, reason: "Fixture permission denied; no read was executed" };
  });
}
`);
  const server = await cursorServer({ toolName: "read", toolArgs: { path: file } });
  try {
    const child = run(binary, ["--mode", "json", "--no-session", "--no-extensions", "--no-mcp", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", probe,
      "--model", "cursor/auto", "--api-key", "mock-cursor-token", "--thinking", "off", "--tools", "read",
      "--system-prompt", "You are a local transport test. Only use the advertised read tool.",
      kind === "text" ? "Reply with PONG" : "TEST_USE_TOOL read the fixture"], {
      cwd: profile, timeout: 20000, maxBuffer: 3 * 1024 * 1024,
      env: { ...process.env, PWD: profile, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0", PI_CURSOR_SYSTEM_CREDENTIALS: "0", CURSOR_ACCESS_TOKEN: "mock-cursor-token",
        PI_CURSOR_AGENT_URL: server.url, PI_CURSOR_CACHE_DIR: join(profile, "cache"),
        PI_CURSOR_STREAM_IDLE_TIMEOUT_MS: "2000", PI_CURSOR_H2_CONNECT_TIMEOUT_MS: "2000",
        PI_CURSOR_STREAM_IDLE_MAX_RETRIES: "0" },
    });
    child.child.stdin?.end();
    const result = await child;
    const events = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    const finished = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
    expect(finished.map(e => e.message.stopReason), JSON.stringify(finished)).not.toContain("error");
    expect(finished.some(e => e.message.stopReason === "stop")).toBe(true);
    expect(finished.every(e => e.message.api === "cursor-native-rust")).toBe(true);
    return { events, runs: server.runs, results: server.results, finished };
  } catch (error) {
    const e = error as { message?: string; stdout?: string; stderr?: string };
    throw new Error([e.message, "mock runs=" + server.runs.length, e.stdout?.slice(-7000), e.stderr?.slice(-3000)].join("\n"));
  } finally { await server.close(); await rm(profile, { recursive: true, force: true }); }
}

describe.skipIf(!available)("actual Pi CLI (isolated profile, real Rust/local H2)", () => {
  it("loads the native provider and returns text/thinking in the real host", async () => {
    const result = await hostCase("text");
    expect(JSON.stringify(result.finished)).toContain("PONG");
    expect(result.runs).toHaveLength(1);
  }, 25000);
  it("executes one allowed host read and fills its result into the parked Rust RPC", async () => {
    const result = await hostCase("read");
    expect(JSON.stringify(result.results)).toContain("PI_HOST_PERMISSION_MARKER");
    expect(JSON.stringify(result.finished)).toContain("TOOL_RESULT_RECEIVED");
    expect(result.runs).toHaveLength(1); expect(result.results).toHaveLength(1);
  }, 25000);
  it("returns a denied host tool result without reading the file", async () => {
    const result = await hostCase("denied");
    expect(JSON.stringify(result.results)).not.toContain("PI_HOST_PERMISSION_MARKER");
    expect(JSON.stringify(result.results)).toMatch(/denied|blocked|permission|error/i);
    expect(result.runs).toHaveLength(1); expect(result.results).toHaveLength(1);
  }, 25000);
});
