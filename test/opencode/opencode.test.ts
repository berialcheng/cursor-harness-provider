import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { cursorServer } from "./fixtures/cursor-server.js";
const run = promisify(execFile);
const binary = process.env.OPENCODE_BIN ?? "opencode";
// Cold hosted Intel startup can exceed 20s before the plugin begins its RPC.
// These bound the external host, not Cursor connection/stream-idle deadlines.
const hostProcessTimeoutMs = 60_000;
const hostCaseTimeoutMs = 75_000;
const pluginDirectory = process.env.CURSOR_PACKED_OPENCODE_DIRECTORY ?? fileURLToPath(new URL("../../packages/opencode", import.meta.url));
if (!isAbsolute(pluginDirectory)) throw new Error("OpenCode plugin test directory must be absolute");
const installed = spawnSync(binary, ["--version"], { encoding: "utf8" });
const available = installed.status === 0 && /2\.2\.5/.test(installed.stdout);
if (process.env.OPENCODE_CURSOR_REQUIRE_HOST === "1" && !available) throw new Error("Required actual OpenCode 2.2.5 host unavailable; refusing to skip host verification");

async function hostCase(kind: "text" | "read" | "denied") {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "cursor-native-opencode-")));
  const config = join(profile, "config", "opencode");
  await mkdir(config, { recursive: true });
  const file = join(profile, "fixture.txt");
  await writeFile(file, "HOST_PERMISSION_TEST_MARKER");
  const server = await cursorServer({ toolName: "read", toolArgs: { path: file } });
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    // Configured local plugins must be DIRECTORIES in OpenCode2.2.5.
    plugins: [pluginDirectory], model: "cursor-native/auto",
    permissions: [{ action: "*", resource: "*", effect: "deny" }, ...(kind === "read" ? [{ action: "read", resource: "*", effect: "allow" }] : [])],
  }));
  const startedAt = Date.now();
  try {
    const command = run(binary, ["run", "--standalone", "--model", "cursor-native/auto", "--format", "json", kind === "text" ? "Reply with PONG" : "TEST_USE_TOOL read the fixture"], {
      cwd: profile, timeout: hostProcessTimeoutMs, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PWD: profile, NODE_ENV: "production", VITEST: "", XDG_CONFIG_HOME: join(profile, "config"), XDG_DATA_HOME: join(profile, "data"), XDG_STATE_HOME: join(profile, "state"), XDG_CACHE_HOME: join(profile, "cache"), OPENCODE_CONFIG_DIR: config,
        OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_DISABLE_FILEWATCHER: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", CURSOR_ACCESS_TOKEN: "mock-cursor-token",
        OPENCODE_CURSOR_AGENT_URL: server.url, OPENCODE_CURSOR_OFFLINE: "1", OPENCODE_CURSOR_CACHE_DIR: join(profile, "cursor-cache"), OPENCODE_CURSOR_STREAM_IDLE_TIMEOUT_MS: "2000", OPENCODE_CURSOR_H2_CONNECT_TIMEOUT_MS: "2000", OPENCODE_CURSOR_STREAM_IDLE_MAX_RETRIES: "0" },
    });
    // run reads piped stdin as additional prompt input; close the empty pipe.
    command.child.stdin?.end();
    const result = await command;
    const events = result.stdout.split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
    expect(events.filter(e => e.type === "error")).toEqual([]);
    expect(events.some(e => e.type === "step_finish" && e.part.reason === "stop")).toBe(true);
    return { events, runs: server.runs, results: server.results };
  } catch (error) {
    const log = await readFile(join(profile, "data/opencode/log/opencode.log"), "utf8").catch(() => "no isolated log");
    const failure = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string; code?: string | number };
    const deadline = `host elapsedMs=${Date.now() - startedAt} limitMs=${hostProcessTimeoutMs} killed=${Boolean(failure.killed)} signal=${failure.signal ?? "none"} code=${failure.code ?? "none"}`;
    throw new Error([failure.message, deadline, "mock runs=" + server.runs.length, failure.stdout, failure.stderr?.slice(-3000), log.slice(-6000)].join("\n"));
  } finally { await server.close(); await rm(profile, { recursive: true, force: true }); }
}

describe.skipIf(!available)("OpenCode 2.2.5 actual host (isolated profile, mock upstream)", () => {
  it("loads the plugin and completes native inference inside the real Bun host", async () => {
    const result = await hostCase("text");
    expect(result.events.some(e => e.type === "text" && e.part.text.includes("PONG"))).toBe(true);
    expect(result.runs.length).toBeGreaterThan(0);
  }, hostCaseTimeoutMs);
  it("executes an explicitly permitted read through OpenCode and resumes Cursor", async () => {
    const result = await hostCase("read");
    expect(JSON.stringify(result.results), JSON.stringify(result.runs.map(r => r.conversationState?.previousWorkspaceUris))).toContain("HOST_PERMISSION_TEST_MARKER");
    expect(result.events.some(e => e.type === "text" && e.part.text === "TOOL_RESULT_RECEIVED")).toBe(true);
  }, hostCaseTimeoutMs);
  it("does not read a file when OpenCode denies the requested tool", async () => {
    const result = await hostCase("denied");
    expect(JSON.stringify(result.results)).not.toContain("HOST_PERMISSION_TEST_MARKER");
    expect(JSON.stringify(result.results)).toMatch(/denied|rejected|not allowed|permission|error|toolNotFound/i);
  }, hostCaseTimeoutMs);
});
