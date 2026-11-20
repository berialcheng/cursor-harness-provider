import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { piCursorServer, png } from "./cursor-server.js";
import { expireFixtureRecord, piOperationsRpc, snapshot } from "./operations-fixture.js";
const run = promisify(execFile);
const requested = process.env.CURSOR_NATIVE_PI_BINARY ?? "pi";
const binary = requested.includes("/") && !isAbsolute(requested) ? resolve(requested) : requested;
const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
const available = version.status === 0 && /\b1\.[45]\.0\b/.test(version.stdout);
if (process.env.CURSOR_NATIVE_REQUIRE_PI === "1" && !available) throw new Error("Required actual Pi1.4/1.5 host unavailable");
// The private development checkout loads TS through Pi's peer mapping; its dev
// SDK1.4 must not shadow host1.5. Packed runs use the installed TS shim + compiled backend.
const extension = process.env.CURSOR_PACKED_PI_EXTENSION ?? fileURLToPath(new URL("../../packages/pi/src/extension.ts", import.meta.url));
if (!isAbsolute(extension)) throw new Error("Pi fixture extension must be absolute");

describe.skipIf(!available)("actual isolated Pi CLI1.4/1.5 enriched catalog + restart", () => {
  it("persists/restores non-auto reasoning routes and history across processes, then sends an explicit host image attachment in Max Mode", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-pi-capabilities-"))), agent = join(root, "agent"), server = await piCursorServer();
    await mkdir(agent); await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
    const image = join(root, "fixture.png"); await writeFile(image, Buffer.from(png, "base64"));
    const args = ["--mode", "json", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", extension,
      "--tools", "read", "--system-prompt", "Local transport fixture. Do not use tools unless explicitly requested."];
    const environment = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "xdg-cache"), PWD: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      PI_CURSOR_SYSTEM_CREDENTIALS: "0", CURSOR_ACCESS_TOKEN: "mock-cursor-token", PI_CURSOR_AGENT_URL: server.url, PI_CURSOR_CACHE_DIR: join(root, "cache"),
      PI_CURSOR_CONNECT_TIMEOUT_MS: "2000", PI_CURSOR_STREAM_IDLE_TIMEOUT_MS: "2000", PI_CURSOR_MAX_RETRIES: "0" };
    const invoke = async (extra: string[], expectAssistant = true) => {
      try {
        const child = run(binary, [...args, ...extra], { cwd: root, env: environment, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); child.child.stdin?.end();
        const { stdout, stderr } = await child;
        const events = stdout.split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
        if (expectAssistant) {
          const assistant = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
          expect(assistant, stdout.slice(-6000)).not.toHaveLength(0);
          expect(assistant.map(e => e.message.stopReason), JSON.stringify(assistant)).not.toContain("error");
          expect(assistant.at(-1).message.stopReason).toBe("stop");
        }
        return stdout + (stderr ? "\nSTDERR:\n" + stderr : "");
      } catch (error) {
        const e = error as { message?: string; stdout?: string; stderr?: string };
        throw new Error([e.message, `runs=${server.runs.length} discovery=${server.discoveryCalls} metadata=${server.metadataCalls}`, e.stdout?.slice(-7000), e.stderr?.slice(-3000)].join("\n"));
      }
    };
    try {
      await invoke(["--no-session", "--model", "cursor/auto", "/cursor.models"], false);
      expect(server.discoveryCalls).toBeGreaterThan(0); expect(server.metadataCalls).toBeGreaterThan(0);
      const sessionArgs = ["--session-dir", join(root, "sessions"), "--session-id", randomUUID()];
      await invoke([...sessionArgs, "--model", "cursor/family", "--thinking", "max", "CLI_PERSISTED_HISTORY_SEED"]);
      expect(server.runs[0]!.requestedModel).toMatchObject({ modelId: "family", maxMode: false,
        parameters: [{ id: "reasoning", value: "max" }, { id: "context", value: "200k" }] });
      const discovery = server.discoveryCalls;
      await invoke([...sessionArgs, "CLI_AFTER_RESTART"]);
      expect(server.discoveryCalls).toBe(discovery);
      expect(server.runs[1]!.conversationId).toBe(server.runs[0]!.conversationId);
      expect(server.roots[1]!.join("\n")).toContain("CLI_PERSISTED_HISTORY_SEED");
      expect(server.roots[1]!.join("\n")).toContain("PONG fixture");
      expect(server.runs[1]!.requestedModel).toMatchObject({ maxMode: false, parameters: [{ id: "reasoning", value: "max" }, { id: "context", value: "200k" }] });
      // @file is an explicit Pi CLI attachment; the provider itself never opens a path.
      await invoke([...sessionArgs, "--model", "cursor/family-1m-max-mode-high-thinking-fast", "--thinking", "high", "@" + image, "Describe the explicitly attached fixture"]);
      const last = server.runs.at(-1)!; expect(last.requestedModel).toMatchObject({ maxMode: true, parameters: [
        { id: "reasoning", value: "high" }, { id: "context", value: "1m" }, { id: "thinking", value: "true" }, { id: "fast", value: "true" },
      ] });
      const action = last.action!.action; if (action.case !== "userMessageAction") throw new Error("Missing fixture user action");
      expect(action.value.userMessage!.selectedContext!.selectedImages[0]!.dataOrBlobId).toEqual({ case: "data", value: Buffer.from(png, "base64") });
      // This also runs from installed tarballs: host shim, compiled backend and compat
      // facade must share the actual host peer registry, with real Rust/local H2.
      const compatProbe = join(root, "compat-probe.ts"), receipt = join(root, "compat-receipt.json");
      const packedCompat = process.env.CURSOR_PACKED_PI_EXTENSION ? pathToFileURL(join(dirname(extension), "../../../@earendil-works/pi-ai/dist/compat.js")).href : "";
      await writeFile(compatProbe, `import { complete, getApiProvider } from "@earendil-works/pi-ai/compat";
import { writeFileSync } from "node:fs";
export default function(pi) {
  const legacy = getApiProvider("cursor-native");
  pi.registerCommand("fixture.compat", { description: "Local compat transport fixture", handler: async (_args, ctx) => {
    let result;
    try { result = await complete(ctx.model, { messages: [{ role: "user", content: "COMPAT_PACKED_NATIVE", timestamp: 1 }] }); }
    catch (error) {
      const physical = ${JSON.stringify(packedCompat)} ? await import(${JSON.stringify(packedCompat)}) : undefined;
      throw new Error(String(error) + " " + JSON.stringify({ viewRegistered: !!getApiProvider("cursor-native-rust"),
        physicalRegistered: !!physical?.getApiProvider("cursor-native-rust"), sameGetter: physical?.getApiProvider === getApiProvider }));
    }
    writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ stopReason: result.stopReason, api: result.api,
      legacyUnchanged: getApiProvider("cursor-native") === legacy }));
  } });
}\n`);
      const compatOutput = await invoke(["--no-session", "--model", "cursor/family", "--thinking", "off", "-e", compatProbe, "/fixture.compat"], false);
      let compatReceipt: string;
      try { compatReceipt = await readFile(receipt, "utf8"); }
      catch { throw new Error("Native compat command did not produce a receipt:\n" + compatOutput.slice(-9000)); }
      expect(JSON.parse(compatReceipt)).toMatchObject({ stopReason: "stop", api: "cursor-native-rust", legacyUnchanged: true });
      const compatRun = server.runs.at(-1)!;
      expect(compatRun.requestedModel).toMatchObject({ modelId: "family", maxMode: false });
      if (compatRun.action!.action.case !== "userMessageAction") throw new Error("Missing native compat action");
      expect(compatRun.action!.action.value.userMessage!.text).toContain("COMPAT_PACKED_NATIVE");
      // Actual selected CLI + selected source/packed extension: public RPC only.
      // Keep this inside the existing capability case so the mandatory packed 6+1
      // gate cannot pass without command -> runtime -> native operations coverage.
      const rpcArgs = [...args]; rpcArgs[rpcArgs.indexOf("json")] = "rpc";
      const rpc = piOperationsRpc(binary, [...rpcArgs, "--no-session", "--model", "cursor/auto"], root, environment);
      try {
        await rpc.prompt("CLI_OPERATIONS_SEED", true);
        const initialConversation = server.runs.at(-1)!.conversationId;
        const doctor = await rpc.prompt("/cursor.doctor");
        expect(doctor).toContain("engine=session-owned");
        // Doctor intentionally redacts scope identities; the public list command
        // is the supported source of full known scopes (no private host access).
        const listing = await rpc.prompt("/cursor.reset");
        const scope = listing.match(/([a-f0-9]{64}) model=auto kind=chat /)?.[1];
        expect(scope, listing).toMatch(/^[a-f0-9]{64}$/);
        const directory = join(root, "cache", "pi", "rust-sessions-v1");
        const reset = await rpc.prompt(`/cursor.reset --scope ${scope} --confirm-discard`);
        expect(reset).toContain("Tool effects are not undone; no request retried");
        expect(await rpc.prompt("/cursor.reset")).toContain("No known scopes in this lifecycle");
        expect(await readdir(directory)).not.toContain(scope + ".bin");
        const unknown = await rpc.prompt(`/cursor.reset --scope ${scope} --confirm-discard`);
        expect(unknown).toContain("Unknown scope");
        await rpc.prompt("CLI_OPERATIONS_AFTER_RESET", true);
        expect(server.runs.at(-1)!.conversationId).not.toBe(initialConversation);
        expect(await rpc.prompt("/cursor.reset")).toContain(scope!);
        // A different, unlocked record was created by the real earlier CLI turn.
        const oldFile = (await readdir(directory)).find(name => name.endsWith(".bin") && name !== scope + ".bin");
        expect(oldFile).toBeDefined();
        const oldPath = join(directory, oldFile!);
        const bytes = await expireFixtureRecord(oldPath);
        const before = await snapshot(directory);
        const dry = await rpc.prompt(`/cursor.cache --scope ${scope}`);
        expect(dry).toContain(`expired=1 applied=0 reclaimableBytes=${bytes}`);
        expect(dry).toMatch(/scanned=\d+ skipped=\d+/);
        expect(dry).toContain("root-wide");
        expect(await snapshot(directory)).toEqual(before);
        const applied = await rpc.prompt(`/cursor.cache --scope ${scope} --apply --confirm-prune`);
        expect(applied).toContain(`expired=1 applied=1 reclaimableBytes=${bytes}`);
        expect(await readFile(oldPath, "utf8")).toBe("CURSREXP");
        expect(doctor).toMatch(/resources=.*\"trackedBytes\":\d+/);
      } finally { await rpc.close(); }
      expect(server.errors).toEqual([]);
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  }, 240000);
});
