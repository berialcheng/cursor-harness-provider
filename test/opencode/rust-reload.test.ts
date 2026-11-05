import { afterEach, expect, it } from "vitest";
import plugin from "../../packages/opencode/src/plugin.js";
import { PACKAGE_ID, SESSION_HEADER, WORKSPACE_HEADER } from "../../packages/opencode/src/model.js";
import { shutdownRustEngines } from "@cursor-harness-provider/native";
import { cursorServer } from "./fixtures/cursor-server.js";
import type { LanguageModelV3 } from "@ai-sdk/provider";
afterEach(() => shutdownRustEngines());
it("versions cached SDK/language factories on activation, not on catalog replay", async () => {
  const server = await cursorServer();
  process.env.OPENCODE_CURSOR_AGENT_URL = server.url;
  const cleanups: Array<() => Promise<void> | void> = [];
  const cache = new Map<string, LanguageModelV3>();
  async function activation() {
    let inventory: any;
    let transform: (editor: any) => void;
    const hooks = new Map<string, (event: any) => void>();
    const sessionHooks = new Map<string, { handler: (event: any) => Promise<void> | void; filter: unknown }>();
    const methods: any[] = [];
    const registration = async () => ({ dispose: async () => {} });
    const context = {
      options: { discovery: false }, location: { directory: "/tmp/rust-reload" },
      aisdk: { hook: async (name: string, fn: (event: any) => void) => { hooks.set(name, fn); return registration(); } },
      integration: {
        transform: async (fn: (e: any) => void) => { fn({ update: () => {}, method: { update: (value: any) => methods.push(value) } }); return registration(); },
        connection: { active: async () => ({ type: "credential", id: "fixture-connection" }), resolve: async () => ({ type: "oauth", access: "mock-cursor-token" }) },
      },
      provider: { transform: async (fn: (e: any) => void) => { transform = fn; fn({ add: (v: any) => { inventory = v; } }); return registration(); } },
      session: {
        hook: async (name: string, handler: (event: any) => Promise<void> | void, filter: unknown) => { sessionHooks.set(name, { handler, filter }); return registration(); },
        get: async ({ sessionID }: { sessionID: string }) => { expect(sessionID).toBe("fixture-session"); return { location: { directory: "/tmp/rust-reload/other workspace" } }; },
      },
    };
    const cleanup = await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);
    if (cleanup) cleanups.push(cleanup);
    const info = inventory.info;
    expect(plugin.id).toBe("@cursor-harness-provider/opencode");
    expect(info).toMatchObject({ id: "cursor-native", integrationID: "cursor-native", package: "aisdk:" + PACKAGE_ID });
    expect(methods).toEqual(expect.arrayContaining([
      expect.objectContaining({ integrationID: "cursor-native", method: expect.objectContaining({ id: "cursor-pkce", type: "oauth" }) }),
      expect.objectContaining({ integrationID: "cursor-native", method: { type: "env", names: ["CURSOR_ACCESS_TOKEN"] } }),
    ]));
    const retry = sessionHooks.get("retry")!;
    expect(retry.filter).toEqual({ providerID: "cursor-native" });
    const failure = { decision: { retry: true, delay: 1 } };
    await retry.handler(failure);
    expect(failure.decision).toEqual({ retry: false });
    const request = sessionHooks.get("model.request")!;
    expect(request.filter).toEqual({ providerID: "cursor-native" });
    const identities = [];
    for (const kind of ["primary", "compaction", "title", "generate"]) {
      const event = { sessionID: "fixture-session", model: { providerID: "cursor-native" }, kind, headers: {} as Record<string, string> };
      await request.handler(event);
      expect(event.headers[WORKSPACE_HEADER]).toBe(encodeURIComponent("/tmp/rust-reload/other workspace"));
      expect(event.headers[SESSION_HEADER]).toBe("fixture-session:" + kind);
      identities.push(event.headers[SESSION_HEADER]);
    }
    expect(new Set(identities).size).toBe(4);
    // Same cache inputs used by the actual 2.2.5 AISDK service, reduced here
    // to the only changing field. Ignoring activation returns a shut-down engine.
    const key = JSON.stringify(info.settings);
    let model = cache.get(key);
    if (!model) {
      const event: any = { model: { providerID: "cursor-native", id: "auto", modelID: "auto" }, package: PACKAGE_ID };
      hooks.get("sdk")!(event); hooks.get("language")!(event);
      model = event.language; cache.set(key, model!);
    }
    const generation = info.settings.cursorNativeActivation;
    transform!({ add: (v: any) => { inventory = v; } });
    expect(inventory.info.settings.cursorNativeActivation).toBe(generation);
    return { model: model!, generation, cleanup };
  }
  const input = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }] };
  try {
    const first = await activation();
    expect((await first.model.doGenerate(input)).finishReason.unified).toBe("stop");
    await first.cleanup?.();
    const second = await activation();
    expect(second.generation).not.toBe(first.generation);
    expect(second.model).not.toBe(first.model);
    expect((await second.model.doGenerate(input)).finishReason.unified).toBe("stop");
    expect(server.runs).toHaveLength(2);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); await server.close(); delete process.env.OPENCODE_CURSOR_AGENT_URL; }
});
