import { describe, expect, it, vi } from "vitest";
import { complete } from "@earendil-works/pi-ai/compat";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryCredentialStore, normalizeContext, Type, type ModelsStore, type ModelsStoreEntry } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime,
  SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRustEngine, type RustEngine } from "@cursor-harness-provider/native";
import { registerCursorNative } from "../../packages/pi/src/index.js";
import { piCursorServer, png } from "./cursor-server.js";

/** File-backed fixture store passed through the real Pi API; no auth-store file is opened. */
class FixtureModelsStore implements ModelsStore {
  constructor(private path: string) {}
  async read(provider: string) { try { return (JSON.parse(await readFile(this.path, "utf8")) as Record<string, ModelsStoreEntry>)[provider]; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; } }
  async write(provider: string, entry: ModelsStoreEntry) { await writeFile(this.path, JSON.stringify({ [provider]: entry })); }
  async delete() { await rm(this.path, { force: true }); }
}
const attach: ToolDefinition = { name: "attach_fixture", label: "Fixture attachment", description: "Return an authorized fixture image",
  parameters: Type.Object({ value: Type.String() }), async execute() { return { content: [{ type: "image", data: png, mimeType: "image/png" }], details: {} }; } };
const settings = (keepRecentTokens?: number) => SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}) },
  defaultProvider: "cursor", defaultModel: "auto", defaultThinkingLevel: "off", cacheWarming: "off" });
const emptyResources = { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  systemPrompt: "Only use advertised host tools. Fixture transport test." };

async function harness(profile: string, url: string, persistent = false, keepRecentTokens?: number) {
  await mkdir(join(profile, "agent"), { recursive: true });
  const store = new FixtureModelsStore(join(profile, "catalog-fixture.json"));
  const requests: Array<Record<string, unknown>> = [], gateCalls: string[] = [], removedScopes: string[] = [];
  let online = true;
  const credentials = new InMemoryCredentialStore(); await credentials.modify("cursor", async () => ({ type: "api_key", key: "mock-cursor-token" }));
  const environment = { PI_CURSOR_SYSTEM_CREDENTIALS: "0", PI_CURSOR_AGENT_URL: url, PI_CURSOR_CACHE_DIR: join(profile, "cache"), PI_CURSOR_CONNECT_TIMEOUT_MS: "2000", PI_CURSOR_STREAM_IDLE_TIMEOUT_MS: "2000", PI_CURSOR_MAX_RETRIES: "0" };
  const gate = (pi: ExtensionAPI) => { pi.on("tool_call", e => { gateCalls.push(e.toolName); if (e.toolName !== "attach_fixture") return { block: true, reason: "Fixture gate denied" }; }); };
  const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({ credentials, modelsStore: store, modelsPath: null, refreshOnCreate: false });
    const services = await createAgentSessionServices({ cwd: profile, agentDir: join(profile, "agent"), modelRuntime, settingsManager: settings(keepRecentTokens),
      resourceLoaderOptions: { ...emptyResources, extensionFactories: [pi => {
        registerCursorNative(pi, { env: () => environment, createEngine: () => {
          const native = createRustEngine();
          const wrapped: RustEngine = { start: (request, token) => { requests.push(JSON.parse(request)); return native.start(request, token); },
            listModels: native.listModels.bind(native), remove: async scope => { await native.remove(scope); removedScopes.push(scope); }, shutdown: native.shutdown.bind(native) };
          return wrapped;
        } }); gate(pi);
      }] } });
    if (online) {
      const refreshed = await modelRuntime.refresh({ providers: ["cursor"], allowNetwork: true });
      expect([...refreshed.errors.entries()]).toEqual([]);
    }
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["attach_fixture"], customTools: [attach] })), services, diagnostics: services.diagnostics };
  };
  const manager = persistent ? SessionManager.create(profile, join(profile, "sessions")) : SessionManager.inMemory(profile);
  const runtime = await createAgentSessionRuntime(factory, { cwd: profile, agentDir: join(profile, "agent"), sessionManager: manager });
  await runtime.session.bindExtensions({});
  return { runtime, requests, gateCalls, removedScopes, factory, credentials, store, gate,
    offline() { online = false; }, environment };
}
async function profile() { return realpath(await mkdtemp(join(tmpdir(), "cursor-pi-sdk-"))); }

describe("actual Pi SDK1.4, native Rust, isolated local H2", () => {
  it("routes inline images, reasoning:max and advertised Max/context/fast/thinking without inventing combinations", async () => {
    const root = await profile(), server = await piCursorServer(); let h: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      h = await harness(root, server.url); const { session } = h.runtime;
      const models = h.runtime.services.modelRuntime;
      expect(models.getModel("cursor", "auto")).toBeDefined();
      const family = models.getModel("cursor", "family")!; expect(family.input).toContain("image");
      await session.setModel(family); session.setThinkingLevel("off");
      await session.prompt("Describe this inline fixture", { images: [{ type: "image", data: png, mimeType: "image/png" }] });
      expect(session.getLastAssistantText(), JSON.stringify(session.messages)).toBe("PONG fixture");
      expect(server.runs[0]!.requestedModel).toMatchObject({ modelId: "family", maxMode: false, parameters: [{ id: "reasoning", value: "none" }, { id: "context", value: "200k" }] });
      const user = server.runs[0]!.action!.action;
      expect(user.case).toBe("userMessageAction");
      if (user.case !== "userMessageAction") throw new Error("Missing user action");
      expect(user.value.userMessage!.selectedContext!.selectedImages[0]!.dataOrBlobId).toEqual({ case: "data", value: Buffer.from(png, "base64") });
      session.setThinkingLevel("max"); await session.prompt("Reasoning max is not Max Mode");
      expect(server.runs[1]!.requestedModel).toMatchObject({ maxMode: false, parameters: [{ id: "reasoning", value: "max" }, { id: "context", value: "200k" }] });
      const extended = models.getModel("cursor", "family-1m-max-mode-high-thinking-fast")!;
      expect(extended.contextWindow).toBe(1000000); await session.setModel(extended); session.setThinkingLevel("high");
      await session.prompt("Use only this advertised extended variant");
      expect(server.runs[2]!.requestedModel).toMatchObject({ maxMode: true, parameters: [
        { id: "reasoning", value: "high" }, { id: "context", value: "1m" }, { id: "thinking", value: "true" }, { id: "fast", value: "true" },
      ] });
      expect(models.getModel("cursor", "family-low")).toBeUndefined();
      await session.setModel(family); session.setThinkingLevel("off"); await session.prompt("Screenshot path only: /tmp/not-a-real-screenshot.png");
      const last = server.runs.at(-1)!.action!.action;
      if (last.case !== "userMessageAction") throw new Error("Missing user action");
      expect(last.value.userMessage!.selectedContext?.selectedImages ?? []).toEqual([]); expect(h.gateCalls).toEqual([]);
      expect(server.errors).toEqual([]); expect(server.metadataCalls).toBeGreaterThan(0);
    } finally { await h?.runtime.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); }
  }, 30000);
  it("continues a real BTW-style copied provider closure through a child host-gated image tool result", async () => {
    const root = await profile(), server = await piCursorServer(); let h: Awaited<ReturnType<typeof harness>> | undefined;
    let child: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    try {
      h = await harness(root, server.url);
      const parentRuntime = h.runtime.services.modelRuntime, config = parentRuntime.getRegisteredProviderConfig("cursor")!;
      // This is the installed BTW mechanism: copy provider config (including its
      // stream closure), but create a different stable Pi session ID/runtime.
      const childModels = await ModelRuntime.create({ credentials: h.credentials, modelsStore: h.store, modelsPath: null, refreshOnCreate: false });
      childModels.registerProvider("cursor", config);
      const services = await createAgentSessionServices({ cwd: root, agentDir: join(root, "agent"), modelRuntime: childModels, settingsManager: settings(), resourceLoaderOptions: { ...emptyResources, extensionFactories: [h.gate] } });
      const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager }) => ({ ...(await createAgentSessionFromServices({ services, sessionManager, model: childModels.getModel("cursor", "family")!, thinkingLevel: "off", tools: ["attach_fixture"], customTools: [attach] })), services, diagnostics: [] });
      child = await createAgentSessionRuntime(factory, { cwd: root, agentDir: join(root, "agent"), sessionManager: SessionManager.inMemory(root) });
      await child.session.bindExtensions({});
      await child.session.prompt("TEST_USE_TOOL return the fixture image");
      expect(child.session.getLastAssistantText(), JSON.stringify(child.session.messages)).toBe("TOOL_RESULT_RECEIVED");
      expect(h.gateCalls).toEqual(["attach_fixture"]); expect(server.runs).toHaveLength(1); expect(server.results).toHaveLength(1);
      expect(h.requests).toHaveLength(2); expect(h.requests[0]!.scope).toBe(h.requests[1]!.scope); expect(h.requests[0]!.stateless).toBe(false);
      expect(JSON.stringify(server.results)).toContain(png);
      await h.runtime.session.prompt("Parent stays isolated");
      expect(h.requests.at(-1)!.scope).not.toBe(h.requests[0]!.scope); expect(server.errors).toEqual([]);
    } finally { await child?.dispose(); await h?.runtime.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); }
  }, 30000);
  it("runs the compat facade through actual native image/parameter routing and a separately scoped tool denial continuation", async () => {
    const root = await profile(), server = await piCursorServer(); let h: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      h = await harness(root, server.url);
      const selected = h.runtime.services.modelRuntime.getModel("cursor", "family")!;
      const single = await complete(selected, normalizeContext({ messages: [{ role: "user", content: [
        { type: "text", text: "Compat image fixture" }, { type: "image", data: png, mimeType: "image/png" },
      ], timestamp: 1 }] }));
      expect(single.stopReason).toBe("stop");
      expect(server.runs[0]!.requestedModel).toMatchObject({ modelId: "family", maxMode: false, parameters: [
        { id: "reasoning", value: "none" }, { id: "context", value: "200k" },
      ] });
      const imageAction = server.runs[0]!.action!.action;
      if (imageAction.case !== "userMessageAction") throw new Error("Missing compat image action");
      const imageData = imageAction.value.userMessage!.selectedContext!.selectedImages[0]!.dataOrBlobId;
      if (imageData.case !== "data") throw new Error("Missing inline compat image bytes");
      expect(Buffer.from(imageData.value)).toEqual(Buffer.from(png, "base64"));
      const oneShotScope = h.requests[0]!.scope as string;
      await vi.waitFor(() => expect(h!.removedScopes).toContain(oneShotScope), { timeout: 3000 });
      await h.runtime.session.setModel(selected); h.runtime.session.setThinkingLevel("off");
      await h.runtime.session.prompt("MAIN_COMPAT_ISOLATION");
      const parentScope = h.requests[1]!.scope;
      const initial = { role: "user" as const, content: "TEST_USE_TOOL through compat", timestamp: 2 };
      const tool = { name: "attach_fixture", description: "Host permission decision required", parameters: Type.Object({ value: Type.String() }) };
      const sessionId = "compat-tool-fixture";
      const first = await complete(selected, normalizeContext({ tools: [tool], messages: [initial] }), { sessionId });
      expect(first.stopReason).toBe("toolUse");
      const second = await complete(selected, normalizeContext({ tools: [tool], messages: [initial, first, {
        role: "toolResult", toolCallId: "1", toolName: "attach_fixture", content: [{ type: "text", text: "Fixture host permission denied" }], isError: true, timestamp: 3,
      }] }), { sessionId });
      expect(second.stopReason).toBe("stop"); expect(JSON.stringify(second.content)).toContain("TOOL_RESULT_RECEIVED");
      expect(JSON.stringify(server.results)).toContain("Fixture host permission denied");
      expect(h.requests[2]!.scope).toBe(h.requests[3]!.scope);
      expect(h.requests[2]!.scope).not.toBe(parentScope); expect(h.requests[2]!.scope).not.toBe(oneShotScope);
      expect(h.gateCalls).toEqual([]); // The direct facade returns the call; this fixture supplies a host denial, never executes a tool.
      expect(server.errors).toEqual([]);
    } finally { await h?.runtime.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); }
  }, 30000);
  it("uses Pi's real tree navigation and manual compaction without retaining the discarded branch checkpoint", async () => {
    const root = await profile(), server = await piCursorServer({ checkpoint: true }); let h: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      h = await harness(root, server.url, true, 32);
      const session = h.runtime.session;
      await session.setModel(h.runtime.services.modelRuntime.getModel("cursor", "family")!); session.setThinkingLevel("off");
      await session.prompt("KEEP_BRANCH_SEED " + "retained fixture context ".repeat(80));
      const anchor = session.sessionManager.getLeafId()!;
      await session.prompt("DISCARDED_BRANCH_SECRET " + "discarded fixture context ".repeat(80));
      const beforeTree = server.runs.at(-1)!.conversationId;
      expect((await session.navigateTree(anchor, { summarize: false })).cancelled).toBe(false);
      await session.prompt("BRANCH_AFTER_TREE " + "recent fixture context ".repeat(80));
      const branch = server.runs.at(-1)!;
      expect(branch.conversationId).not.toBe(beforeTree);
      expect(branch.conversationState?.summary?.length ?? 0).toBe(0);
      expect(server.roots.at(-1)!.join("\n")).toContain("KEEP_BRANCH_SEED");
      expect(server.roots.at(-1)!.join("\n")).not.toContain("DISCARDED_BRANCH_SECRET");
      const beforeCompact = branch.conversationId;
      const compacted = await session.compact("Summarize the retained fixture branch only.");
      expect(compacted.summary).toContain("PONG fixture");
      expect(h.requests.at(-1)!.stateless).toBe(true); // The summarizer never shares the chat checkpoint.
      await session.prompt("AFTER_REAL_COMPACTION");
      const after = server.runs.at(-1)!;
      expect(session.getLastAssistantText(), JSON.stringify(session.messages)).toBe("PONG fixture");
      expect(after.conversationId).not.toBe(beforeCompact);
      expect(after.conversationState?.summary?.length ?? 0).toBe(0);
      expect(server.roots.at(-1)!.join("\n")).not.toContain("DISCARDED_BRANCH_SECRET");
      expect(server.errors).toEqual([]);
    } finally { await h?.runtime.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); }
  }, 30000);
  it("reloads/resumes a persistent non-auto session and public catalog offline while native history remains available", async () => {
    const root = await profile(), server = await piCursorServer(); let h: Awaited<ReturnType<typeof harness>> | undefined;
    let restarted: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    try {
      h = await harness(root, server.url, true);
      await h.runtime.session.setModel(h.runtime.services.modelRuntime.getModel("cursor", "family")!); h.runtime.session.setThinkingLevel("high");
      await h.runtime.session.prompt("PERSISTED_HISTORY_SEED"); const file = h.runtime.session.sessionFile!;
      expect(file).toBeTruthy(); const firstScope = h.requests[0]!.scope; const firstConversation = server.runs[0]!.conversationId;
      await h.runtime.dispose(); h.offline(); const discovery = server.discoveryCalls;
      restarted = await createAgentSessionRuntime(h.factory, { cwd: root, agentDir: join(root, "agent"), sessionManager: SessionManager.open(file), sessionStartEvent: { type: "session_start", reason: "resume" } });
      await restarted.session.bindExtensions({});
      expect(restarted.modelFallbackMessage).toBeUndefined(); expect(restarted.session.model?.id).toBe("family");
      expect(restarted.session.thinkingLevel).toBe("high");
      await restarted.session.prompt("AFTER_RESTART");
      expect(restarted.session.getLastAssistantText(), JSON.stringify(restarted.session.messages)).toBe("PONG fixture");
      expect(server.discoveryCalls).toBe(discovery); expect(h.requests[1]!.scope).toBe(firstScope);
      expect(server.runs[1]!.conversationId).toBe(firstConversation);
      expect(server.roots[1]!.join("\n")).toContain("PERSISTED_HISTORY_SEED");
      expect(server.roots[1]!.join("\n")).toContain("PONG fixture"); expect(server.errors).toEqual([]);
    } finally { await restarted?.dispose(); await h?.runtime.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); }
  }, 30000);
});
