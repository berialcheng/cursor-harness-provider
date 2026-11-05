import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { create, fromJson, toBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createNativeModel, SESSION_HEADER, WORKSPACE_HEADER, type AccessTokenProvider } from "../../packages/opencode/src/model.js";
import { createRustEngine, nativeBindingPath, nativeVersion, shutdownRustEngines, type RustEngine, type RustStream } from "@cursor-harness-provider/native";
import { FetchArgsSchema, McpArgsSchema, ReadArgsSchema, ShellArgsSchema, WriteArgsSchema } from "../reference/pi-cursor/src/proto/agent_pb.js";
import { frameConnectMessage } from "../reference/pi-cursor/src/client/bridge.js";
import {
  bounded, finishRustTurn, rustCursorServer, sendRustExec, sendRustText,
  type RustCursorRun,
} from "./fixtures/rust-cursor-server.js";

// No global auth/config, JS inference engine, or live Cursor endpoint is used here.
const TOKEN = "fixture-access-token-not-a-credential";
const owned: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  vi.stubEnv("OPENCODE_CURSOR_AGENT_URL", "http://127.0.0.1:9");
  vi.stubEnv("OPENCODE_CURSOR_STREAM_IDLE_MAX_RETRIES", "0");
  vi.stubEnv("OPENCODE_CURSOR_H2_CONNECT_TIMEOUT_MS", "1000");
});
afterEach(async () => {
  shutdownRustEngines();
  const results = await Promise.allSettled(owned.splice(0).reverse().map(close => close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
async function fixture(options: Parameters<typeof rustCursorServer>[0] = {}) {
  const server = await rustCursorServer(options);
  owned.push(async () => { await server.close(); expect(server.errors).toEqual([]); });
  vi.stubEnv("OPENCODE_CURSOR_AGENT_URL", server.url);
  return server;
}
async function privateDirectory(prefix: string) {
  // setup.ts supplies a private, canonical cache root; never touch the user's cache.
  const root = process.env.OPENCODE_CURSOR_CACHE_DIR;
  if (!root) throw new Error("Tests require the isolated cache from setup.ts");
  const directory = await realpath(await mkdtemp(join(root, prefix)));
  owned.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const authHash = (token: string) => createHash("sha256").update("Bearer " + token).digest("hex");
const provider = (scope: string, token = TOKEN): AccessTokenProvider => Object.assign(async () => token, { scope });
function prompt(text: string, session: string = randomUUID(), workspace?: string): LanguageModelV3CallOptions {
  return { headers: { [SESSION_HEADER]: session, ...(workspace ? { [WORKSPACE_HEADER]: encodeURIComponent(workspace) } : {}) },
    prompt: [{ role: "user", content: [{ type: "text", text }] }] };
}
function model(engine = createRustEngine(), getAccessToken: AccessTokenProvider = provider("fixture-account")) {
  return createNativeModel({ engine, modelId: "auto", workspace: "/tmp/rust-runtime", getAccessToken });
}
function generate(native: LanguageModelV3, options: LanguageModelV3CallOptions) {
  return bounded(native.doGenerate(options), "Rust generation");
}
async function observe(native: LanguageModelV3, options: LanguageModelV3CallOptions) {
  const reader = (await bounded(native.doStream(options), "Rust stream start")).stream.getReader(), events: LanguageModelV3StreamPart[] = [];
  try {
    // A timeout is a test failure, NOT an acceptable native protocol error.
    const error = await bounded((async () => {
      try {
        for (let i = 0; i < 128; i++) {
          const result = await reader.read();
          if (result.done) return undefined;
          events.push(result.value);
        }
        throw new Error("Fixture exceeded bounded event count");
      } catch (error) { return error; }
    })(), "native event drain");
    return { events, error };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function userText(run: RustCursorRun) {
  const action = run.request.action?.action;
  return action?.case === "userMessageAction" ? action.value.userMessage?.text : undefined;
}
function replies(server: Awaited<ReturnType<typeof fixture>>) {
  return server.messages.flatMap(message => message.message.case === "execClientMessage" ? [message.message.value] : []);
}

describe("production Rust runtime (NAPI + localhost HTTP/2)", () => {
  it("loads NativeEngine 0.3.0 through the shared package without a JS protocol fallback", async () => {
    const binding = createRequire(import.meta.url)(nativeBindingPath()) as {
      nativeVersion(): string; NativeEngine: new () => RustEngine;
    };
    const runtimePackage = new URL("../../packages/native/", import.meta.url);
    const hostPackage = new URL("../../packages/opencode/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("package.json", runtimePackage), "utf8"));
    expect(manifest.name).toBe("@cursor-harness-provider/native");
    expect(manifest.version).toBe("0.3.0");
    expect(nativeVersion()).toBe(manifest.version);
    expect(binding.nativeVersion()).toBe(manifest.version);
    expect(createRustEngine()).toBeInstanceOf(binding.NativeEngine);
    expect(nativeBindingPath()).toMatch(/[.]node$/);
    for (const [base, name, shared] of [[runtimePackage, "index", true], [hostPackage, "model", false], [hostPackage, "plugin", false]] as const) {
      const code = await readFile(new URL("dist/" + name + ".js", base), "utf8");
      const map = JSON.parse(await readFile(new URL("dist/" + name + ".js.map", base), "utf8")) as { sources: string[] };
      expect(map.sources).toContain(shared ? "../src/index.ts" : "../src/model.ts");
      expect(map.sources.filter(source => /test\/reference\/|vendor\/pi-cursor\/src\/(?:stream|client|proto)\/|reference-model\./.test(source))).toEqual([]);
      expect(map.sources.some(source => /packages\/pi\//.test(source))).toBe(false);
      if (shared) {
        expect(code).toMatch(/\.NativeEngine\)?\(\)/);
        expect(code).toContain("manifest.json");
        expect(map.sources.some(source => /packages\/opencode\//.test(source))).toBe(false);
      } else {
        expect(code).toMatch(/from ["']@cursor-harness-provider\/native["']/);
        expect(code).not.toMatch(/\.NativeEngine\(|manifest\.json|node:module/);
      }
      expect(code).not.toMatch(/@earendil-works\/|@opencode\/plugin|@bufbuild\/|node:http2|streamCursor|createConnectFrameParser/);
    }
    // Relocate BOTH built packages, omitting only the shared runtime's native/
    // directory. The host must fail before credentials; it cannot load a second
    // embedded binding or silently fall back to a CLI/JS engine.
    const directory = await privateDirectory("artifact-without-binding-");
    const artifact = join(directory, "model.mjs");
    const relocatedRuntime = join(directory, "node_modules", "@cursor-harness-provider", "native");
    await mkdir(join(relocatedRuntime, "dist"), { recursive: true });
    await writeFile(join(relocatedRuntime, "package.json"), JSON.stringify(manifest));
    await writeFile(join(relocatedRuntime, "dist", "index.js"), await readFile(new URL("dist/index.js", runtimePackage)));
    await writeFile(artifact, await readFile(new URL("dist/model.js", hostPackage)));
    const script = `const { createNativeModel } = await import(${JSON.stringify(pathToFileURL(artifact).href)});
      const { nativeBindingPath } = await import(${JSON.stringify(pathToFileURL(join(relocatedRuntime, "dist", "index.js")).href)});
      let tokenCalls = 0, failure, diagnostic;
      try { nativeBindingPath(); } catch (error) { diagnostic = error.message; }
      try { createNativeModel({ modelId: 'auto', workspace: '/tmp', getAccessToken: async () => { tokenCalls++; throw new Error('must not resolve credentials'); } }); }
      catch (error) { failure = error.message; }
      process.stdout.write(JSON.stringify({ failure, diagnostic, tokenCalls }));`;
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 8192 });
    const result = JSON.parse(child.stdout);
    expect(result.failure).toMatch(/Rust Cursor binding (?:unavailable|cannot load)/);
    expect(result.diagnostic).toMatch(/Rust Cursor binding unavailable/);
    expect(result.diagnostic).toContain("There is no CLI/JS inference fallback");
    expect(result.tokenCalls).toBe(0);
    expect(child.stderr).toBe("");
  });

  it("isolates account/model/workspace/session scopes on real requests, not just JS hashes", async () => {
    const server = await fixture({ onRun: ({ stream }) => { sendRustText(stream, "scope-ok"); finishRustTurn(stream); } });
    const engine = createRustEngine(), scopes: string[] = [];
    const a = { id: "account-a", token: "fixture-account-a-1" }, b = { id: "account-b", token: "fixture-account-b-1" };
    let selected = a;
    const getAccessToken = vi.fn(async () => { throw new Error("Must use the bound account, not the live account selector"); });
    const bindAccessToken = vi.fn(async () => {
      // Same semantics as plugin.ts: freeze account identity for this request.
      const account = selected;
      return Object.assign(async () => account.token, { scope: account.id });
    });
    const config = { engine, workspace: "/tmp/rust-runtime", getAccessToken, bindAccessToken, onSession: (scope: string) => scopes.push(scope) };
    const native = createNativeModel({ ...config, modelId: "auto" });
    const session = randomUUID(), base = prompt("scope probe", session);
    const run = async (m = native, options = base) => expect((await generate(m, options)).content).toEqual([{ type: "text", text: "scope-ok" }]);
    await run();
    a.token = "fixture-account-a-2"; // Refreshing a token must NOT switch account scope.
    await run();
    selected = b;
    await run();
    await run(createNativeModel({ ...config, modelId: "fixture-other-model" }));
    const otherWorkspace = "/tmp/rust-runtime/other workspace";
    await run(native, prompt("workspace probe", session, otherWorkspace));
    await run(native, prompt("session probe", session + "-other"));
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(bindAccessToken).toHaveBeenCalledTimes(6);
    expect(server.runs).toHaveLength(6);
    const ids = server.runs.map(run => run.request.conversationId);
    expect(ids.every(id => typeof id === "string" && id.length > 0)).toBe(true);
    expect(ids[1]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(5);
    const expected = [
      [a.id, "auto", config.workspace, session], [a.id, "auto", config.workspace, session],
      [b.id, "auto", config.workspace, session], [b.id, "fixture-other-model", config.workspace, session],
      [b.id, "auto", otherWorkspace, session], [b.id, "auto", config.workspace, session + "-other"],
    ].map(binding => createHash("sha256").update(JSON.stringify(["opencode", ...binding])).digest("hex"));
    expect(scopes).toEqual(expected);
    const piScope = createHash("sha256").update(JSON.stringify(["pi", a.id, "auto", config.workspace, session])).digest("hex");
    expect(scopes).not.toContain(piScope);
    expect(server.runs.map(run => run.authorizationHash)).toEqual([
      authHash("fixture-account-a-1"), authHash(a.token), ...Array(4).fill(authHash(b.token)),
    ]);
    expect(server.runs.map(run => run.request.requestedModel?.modelId)).toEqual(["default", "default", "default", "fixture-other-model", "default", "default"]);
    expect(server.runs.map(run => run.request.conversationState?.previousWorkspaceUris)).toEqual([
      ["file:///tmp/rust-runtime"], ["file:///tmp/rust-runtime"], ["file:///tmp/rust-runtime"],
      ["file:///tmp/rust-runtime"], ["file:///tmp/rust-runtime/other%20workspace"], ["file:///tmp/rust-runtime"],
    ]);
    expect(server.runs.every(run => run.path === "/agent.v1.AgentService/Run")).toBe(true);
    for (const secret of [a.token, b.token, a.id, b.id, session]) expect(JSON.stringify([scopes, ids]).includes(secret)).toBe(false);
  });

  it("keeps different scopes concurrently active in one real engine without cross-talk", async () => {
    const server = await fixture(), engine = createRustEngine(), cwd = process.cwd();
    const left = model(engine, provider("parallel-left", "fixture-left-token"));
    const right = model(engine, provider("parallel-right", "fixture-right-token"));
    const session = randomUUID();
    // Neither request can complete until BOTH Run RPCs are observed on the wire.
    const pending = Promise.all([
      generate(left, prompt("left", session, "/tmp/parallel-left")),
      generate(right, prompt("right", session, "/tmp/parallel-right")),
    ]);
    void pending.catch(() => {});
    await server.waitForRuns(2);
    expect(server.activeStreams).toBe(2);
    expect(new Set(server.runs.map(run => run.request.conversationId)).size).toBe(2);
    for (const run of server.runs) {
      const side = userText(run);
      expect(["left", "right"]).toContain(side);
      expect(run.authorizationHash).toBe(authHash("fixture-" + side + "-token"));
      expect(run.request.conversationState?.previousWorkspaceUris).toEqual(["file:///tmp/parallel-" + side]);
      sendRustText(run.stream, "reply-" + side); finishRustTurn(run.stream);
    }
    const results = await bounded(pending, "parallel generations");
    expect(results.map(result => result.content)).toEqual([[{ type: "text", text: "reply-left" }], [{ type: "text", text: "reply-right" }]]);
    expect(results.map(result => result.finishReason.unified)).toEqual(["stop", "stop"]);
    expect(process.cwd()).toBe(cwd);
  });

  it("aborts pending token acquisition without calling NativeEngine.start or opening a wire", async () => {
    const server = await fixture(), engine = createRustEngine(), start = vi.spyOn(engine, "start");
    const token = deferred<string>(), entered = deferred<AbortSignal | undefined>(), abort = new AbortController();
    const getAccessToken = vi.fn(({ signal }: { signal?: AbortSignal } = {}) => { entered.resolve(signal); return token.promise; });
    const native = model(engine, Object.assign(getAccessToken, { scope: "frozen-pending-account" }));
    const pending = native.doStream({ ...prompt("no wire"), abortSignal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      const signal = await bounded(entered.promise, "token acquisition");
      expect(signal?.aborted).toBe(false);
      abort.abort();
      await bounded(rejected, "token abort rejection");
      expect(signal?.aborted).toBe(true);
      token.resolve(TOKEN); // Even a late credential resolution cannot start inference.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(getAccessToken).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      expect(server.runs).toHaveLength(0);
      expect(server.connections).toBe(0);
    } finally { abort.abort(); token.resolve(TOKEN); }
  });

  it.each([
    ["bare EOF", Buffer.alloc(0)],
    ["successful Connect envelope without TurnEnded", frameConnectMessage(Buffer.from("{}"), 2)],
    ["truncated Connect header", Buffer.from([0, 0])],
    ["truncated Connect payload", Buffer.from([0, 0, 0, 0, 3, 0x12])],
    ["invalid Connect flags", Buffer.from([4, 0, 0, 0, 0])],
    ["corrupt protobuf", frameConnectMessage(Buffer.from([0xff]))],
  ])("does not synthesize finish for %s", async (_name, response) => {
    const server = await fixture({ onRun: ({ stream }) => stream.end(response) });
    const result = await observe(model(), prompt("bad response"));
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/without TurnEnded|Unsupported, corrupt, or out-of-bounds/);
    expect(result.events.some(event => event.type === "finish")).toBe(false);
    expect(result.events.some(event => event.type === "text-delta" || event.type === "tool-call")).toBe(false);
    expect(server.runs).toHaveLength(1);
  });

  it.each(["textDelta", "thinkingDelta"] as const)("refuses unsafe retries after exposed %s even with retry budget left", async kind => {
    vi.stubEnv("OPENCODE_CURSOR_STREAM_IDLE_MAX_RETRIES", "3");
    const server = await fixture({ onRun: ({ stream }) => {
      sendRustText(stream, "partial 😀", kind);
      stream.end(frameConnectMessage(Buffer.from("{}"), 2));
    } });
    const result = await observe(model(), prompt("partial response"));
    const deltaType = kind === "textDelta" ? "text-delta" : "reasoning-delta";
    expect(result.events.flatMap(event => (event.type === "text-delta" || event.type === "reasoning-delta") && event.type === deltaType ? [event.delta] : [])).toEqual(["partial 😀"]);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/after partial output.*refusing blind replay/);
    expect(result.events.some(event => event.type === "finish")).toBe(false);
    expect(server.runs).toHaveLength(1);
  });

  it("denies native read/write/shell/fetch with typed wire replies and never leaks a tempfile sentinel", async () => {
    const directory = await privateDirectory("native-denials-"), sentinelPath = join(directory, "private.txt");
    const sentinel = "PRIVATE_SENTINEL_" + randomUUID(), marker = join(directory, "shell-ran");
    await writeFile(sentinelPath, sentinel, { mode: 0o600 });
    let fetchConnections = 0;
    const trap = createServer((_request, response) => response.end(sentinel));
    trap.on("connection", () => fetchConnections++);
    owned.push(() => bounded(new Promise<void>((resolve, reject) => {
      trap.closeAllConnections(); trap.close(error => error ? reject(error) : resolve());
    }), "fetch trap close"));
    await bounded(new Promise<void>((resolve, reject) => { trap.once("error", reject); trap.listen(0, "127.0.0.1", resolve); }), "fetch trap listen");
    const address = trap.address();
    if (!address || typeof address === "string") throw new Error("Missing fetch trap address");
    const url = "http://127.0.0.1:" + address.port + "/private";
    let count = 0;
    const server = await fixture({
      onRun: ({ stream }) => {
        sendRustExec(stream, 11, { case: "readArgs", value: create(ReadArgsSchema, { path: sentinelPath, toolCallId: "native-read" }) });
        sendRustExec(stream, 12, { case: "writeArgs", value: create(WriteArgsSchema, { path: sentinelPath, fileText: "overwritten", toolCallId: "native-write", returnFileContentAfterWrite: true }) });
        sendRustExec(stream, 13, { case: "shellArgs", value: create(ShellArgsSchema, { command: `cat '${sentinelPath}'; printf ran > '${marker}'`, workingDirectory: directory, toolCallId: "native-shell" }) });
        sendRustExec(stream, 14, { case: "fetchArgs", value: create(FetchArgsSchema, { url, toolCallId: "native-fetch" }) });
      },
      onMessage: (message, stream) => {
        if (message.message.case === "execClientMessage" && ++count === 4) { sendRustText(stream, "denied-safely"); finishRustTurn(stream); }
      },
    });
    const result = await generate(model(), prompt("native requests are not host permission grants", randomUUID(), directory));
    expect(result.content).toEqual([{ type: "text", text: "denied-safely" }]);
    expect(result.finishReason.unified).toBe("stop");
    const execs = replies(server);
    expect(execs.map(exec => [exec.id, exec.execId, exec.message.case])).toEqual([
      [11, "exec-11", "readResult"], [12, "exec-12", "writeResult"], [13, "exec-13", "shellResult"], [14, "exec-14", "fetchResult"],
    ]);
    for (const exec of execs) {
      const message = exec.message;
      if (message.case !== "readResult" && message.case !== "writeResult" && message.case !== "shellResult" && message.case !== "fetchResult") throw new Error("Missing typed denial");
      expect(message.value.result.case).toBe(message.case === "fetchResult" ? "error" : "rejected");
      expect(JSON.stringify(message.value)).toContain("No operation was performed");
    }
    expect(await readFile(sentinelPath, "utf8") === sentinel).toBe(true);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchConnections).toBe(0);
    expect(server.clientFrames.some(frame => frame.includes(Buffer.from(sentinel)))).toBe(false);
    expect(JSON.stringify(result).includes(sentinel)).toBe(false);
  });

  it("rejects raw unknown/malformed MCP and unknown result IDs without consuming the real pending call", async () => {
    const args = { path: "not-a-local-read", nested: { flag: true, values: [1, null, "value"] } };
    const encoded = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, toBinary(ValueSchema, fromJson(ValueSchema, value))]));
    let rejected = 0;
    const server = await fixture({
      onRun: ({ stream }) => {
        sendRustExec(stream, 21, { case: "mcpArgs", value: create(McpArgsSchema, { name: "mcp_pi_unregistered", toolName: "unregistered", providerIdentifier: "pi", toolCallId: "unknown-call" }) });
        sendRustExec(stream, 22, { case: "mcpArgs", value: create(McpArgsSchema, { name: "mcp_pi_read", toolName: "read", providerIdentifier: "pi", toolCallId: "corrupt-call", args: { path: Uint8Array.of(0xff) } }) });
      },
      onMessage: ({ message }, stream) => {
        const denial = message.case === "execClientMessage" && message.value.id === 21
          || message.case === "execClientControlMessage" && message.value.message.case === "throw" && message.value.message.value.id === 22;
        if (denial) {
          if (++rejected === 2) sendRustExec(stream, 23, { case: "mcpArgs", value: create(McpArgsSchema, {
            name: "mcp_pi_read", toolName: "read", providerIdentifier: "pi", toolCallId: "known-call", args: encoded,
          }) }, "real-exec-envelope");
        } else if (message.case === "execClientMessage" && message.value.id === 23) {
          sendRustText(stream, "result-accepted"); finishRustTurn(stream);
        }
      },
    });
    const native = model(), options: LanguageModelV3CallOptions = { ...prompt("raw MCP"), tools: [
      { type: "function", name: "read", inputSchema: { type: "object", properties: { path: { type: "string" }, nested: { type: "object" } } } },
    ] };
    const first = await generate(native, options);
    expect(first.finishReason.unified).toBe("tool-calls");
    expect(first.content).toHaveLength(1);
    expect(first.content[0]).toMatchObject({ type: "tool-call", toolCallId: "known-call", toolName: "read", providerExecuted: false });
    if (first.content[0]?.type !== "tool-call") throw new Error("Missing host call");
    expect(JSON.parse(first.content[0].input)).toEqual(args);
    expect(replies(server).map(exec => [exec.id, exec.message.case])).toEqual([[21, "mcpResult"]]);
    const unknown = replies(server)[0]!.message;
    if (unknown.case !== "mcpResult") throw new Error("Missing MCP rejection");
    expect(unknown.value.result.case).toBe("toolNotFound");
    const controls = server.messages.flatMap(({ message }) => message.case === "execClientControlMessage" ? [message.value.message] : []);
    expect(controls).toHaveLength(1);
    const corrupt = controls[0]!;
    if (corrupt.case !== "throw") throw new Error("Missing corrupt-Value rejection");
    expect(corrupt.value.id).toBe(22);
    expect(corrupt.value.error).toContain("Invalid MCP argument protobuf Value");
    const continuation = (id: string): LanguageModelV3CallOptions => ({ ...options, prompt: [
      ...options.prompt, { role: "assistant", content: [{ type: "tool-call", toolCallId: "known-call", toolName: "read", input: args }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "HOST_EXECUTED_RESULT" } }] },
    ] });
    const bad = await observe(native, continuation("unknown-result-id"));
    expect(bad.error).toBeInstanceOf(Error);
    expect((bad.error as Error).message).toContain("Host results do not match pending calls");
    expect(bad.events.some(event => event.type === "finish" || event.type === "tool-call")).toBe(false);
    expect(replies(server)).toHaveLength(1);
    expect(server.activeStreams).toBe(1);
    const final = await generate(native, continuation("known-call"));
    expect(final.content).toEqual([{ type: "text", text: "result-accepted" }]);
    expect(final.finishReason.unified).toBe("stop");
    expect(server.runs).toHaveLength(1); // Matching continuation used the parked RPC.
    expect(replies(server)).toHaveLength(2);
    const reply = replies(server)[1]!;
    expect([reply.id, reply.execId, reply.message.case]).toEqual([23, "real-exec-envelope", "mcpResult"]);
    if (reply.message.case !== "mcpResult") throw new Error("Missing result");
    expect(reply.message.value.result.case).toBe("success");
    if (reply.message.value.result.case !== "success") throw new Error("Missing successful host result");
    expect(reply.message.value.result.value.content[0]?.content).toMatchObject({ case: "text", value: { text: "HOST_EXECUTED_RESULT" } });
  });

  it("cancels a late REAL Rust start handle after the host aborts its pending NAPI result", async () => {
    const server = await fixture(), real = createRustEngine(), gate = deferred<void>(), ready = deferred<RustStream>(), cancelled = deferred<void>(), removed = deferred<void>();
    const remove = vi.fn(async (scope: string) => { await real.remove(scope); removed.resolve(); });
    const abort = new AbortController();
    const cancel = vi.fn((stream: RustStream) => { stream.cancel(); cancelled.resolve(); });
    // Delay delivery, not inference: every event and wire operation is Rust-owned.
    const delayed: RustEngine = {
      async start(request, token) {
        const native = await real.start(request, token);
        const handle: RustStream = { nextEvent: () => native.nextEvent(), setAccessToken: token => native.setAccessToken(token), cancel: () => cancel(native) };
        ready.resolve(handle);
        await gate.promise;
        return handle;
      },
      listModels: (token, url) => real.listModels(token, url), remove, shutdown: () => real.shutdown(),
    };
    const pending = model(delayed).doStream({ ...prompt("hold Rust open"), headers: { [WORKSPACE_HEADER]: encodeURIComponent("/tmp/rust-runtime") }, abortSignal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      await bounded(ready.promise, "real native handle");
      const [run] = await server.waitForRuns(1);
      abort.abort();
      await bounded(rejected, "pending start abort rejection"); // Before late handle delivery.
      expect(cancel).not.toHaveBeenCalled();
      gate.resolve();
      await bounded(cancelled.promise, "late native cancellation");
      await bounded(removed.promise, "late stateless scope removal");
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(cancel).toHaveBeenCalledTimes(1);
      await bounded(run!.closed, "cancelled HTTP/2 stream close");
      expect(server.activeStreams).toBe(0);
      expect(server.runs).toHaveLength(1);
    } finally { abort.abort(); gate.resolve(); real.shutdown(); }
  });
});
