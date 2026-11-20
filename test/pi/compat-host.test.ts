import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
const binary = process.env.CURSOR_NATIVE_PI_BINARY ?? "pi";
const available = /\b1\.[45]\.0\b/.test(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout ?? "");
if (process.env.CURSOR_NATIVE_REQUIRE_PI === "1" && !available) throw new Error("Required actual Pi1.4/1.5 compat host unavailable");
const extension = fileURLToPath(new URL("../../packages/pi/src/index.ts", import.meta.url));

// Real extension loader + real compat facade, fake engine: no native build or network dependency.
describe.skipIf(!available)("compat in an isolated actual Pi host", () => {
  it("shares the host peer registry and resolves compat credentials canonically", async () => {
    const profile = await realpath(await mkdtemp(join(tmpdir(), "cursor-compat-host-")));
    try {
      const agent = join(profile, "agent"), receipt = join(profile, "receipt.json"), probe = join(profile, "probe.ts");
      await mkdir(agent);
      await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }));
      await writeFile(probe, `
import { registerCursorNative } from ${JSON.stringify(extension)};
import { complete, streamSimple, getApiProvider } from "@earendil-works/pi-ai/compat";
import { writeFileSync } from "node:fs";
export default function(pi) {
  const starts = [], removed = [];
  const engine = {
    async start(raw, token) {
      starts.push({ ...JSON.parse(raw), token });
      const events = [{type:"text-start",id:"t"},{type:"text-delta",id:"t",delta:"FAKE_HOST_OK"},{type:"text-end",id:"t"},
        {type:"finish",finishReason:{unified:"stop",raw:"stop"},usage:{}}];
      return { async nextEvent(){return events.length ? JSON.stringify(events.shift()) : null;}, cancel(){}, async setAccessToken(){} };
    },
    async listModels(){return "[]";}, async remove(scope){removed.push(scope);}, shutdown(){}
  };
  const legacy = getApiProvider("cursor-native");
  registerCursorNative(pi, { createEngine: () => engine, env: () => ({ PI_CURSOR_SYSTEM_CREDENTIALS:"0", PI_CURSOR_AGENT_URL:"http://127.0.0.1:9", PI_CURSOR_CACHE_DIR:${JSON.stringify(join(profile, "cache"))} }) });
  pi.on("session_start", async (_event, ctx) => {
    const context = {messages:[{role:"user",content:"fixture compat",timestamp:1}]};
    const one = await complete(ctx.model, context);
    const two = await streamSimple(ctx.model, context, {sessionId:ctx.sessionManager.getSessionId()}).result();
    await new Promise(resolve => setImmediate(resolve));
    writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({one:one.stopReason,two:two.stopReason,legacyUnchanged:getApiProvider("cursor-native")===legacy,starts,removed}));
  });
}
`);
      const child = run(binary, ["--mode", "json", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", probe,
        "--model", "cursor/auto", "--thinking", "off", "--tools", "", "--system-prompt", "fixture", "fixture"], {
        cwd: profile, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", CURSOR_ACCESS_TOKEN: "fixture-compat-host-key", PI_CURSOR_SYSTEM_CREDENTIALS: "0", NO_PROXY: "*", no_proxy: "*" },
      });
      child.child.stdin?.end(); await child;
      const result = JSON.parse(await readFile(receipt, "utf8"));
      expect(result).toMatchObject({ one: "stop", two: "stop", legacyUnchanged: true });
      expect(result.starts).toHaveLength(2);
      expect(result.starts.map((p: any) => p.stateless)).toEqual([true, false]);
      expect(result.starts.every((p: any) => p.token === "fixture-compat-host-key")).toBe(true);
      expect(result.starts[0].scope).not.toBe(result.starts[1].scope);
      expect(result.removed).toEqual([result.starts[0].scope]);
    } finally { await rm(profile, { recursive: true, force: true }); }
  }, 40000);
});
