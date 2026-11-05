import { createHash, randomUUID } from "node:crypto";
import type { Plugin, Model, Provider, Integration, Credential } from "@opencode/plugin";
import { createNativeModel, PROVIDER_ID, PACKAGE_ID, SESSION_HEADER, WORKSPACE_HEADER, type NativeModelOptions } from "./model.js";
import { createCursorAuthClient, type CursorCredentials } from "../../../vendor/pi-cursor/src/auth/oauth.js";
import { createRustEngine } from "@cursor-harness-provider/native";
interface CursorModel { id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; requestedModelId?: string; parameters?: unknown[]; requiresMaxMode?: boolean; supportsImages?: boolean; }

const providerID = PROVIDER_ID as Provider.ID;
const integrationID = PROVIDER_ID as Integration.ID;
const oauthMethodID = "cursor-pkce" as Credential.OAuth["methodID"];

function oauthCredential(value: CursorCredentials): Credential.OAuth {
  return { type: "oauth", methodID: oauthMethodID, ...value };
}

export function catalogModel(model: CursorModel): Model.Info {
  return {
    id: model.id as Model.ID,
    modelID: (model.requestedModelId ?? model.id) as Model.ID,
    providerID,
    name: model.name,
    capabilities: { tools: true, input: model.supportsImages ? ["text", "image"] : ["text"], output: ["text"], temperature: false },
    limit: { context: model.contextWindow, output: model.maxTokens },
    variants: [], status: "active", enabled: true, time: { released: 0 }, cost: [],
  };
}

/** No CLI invocation, API proxy, global registry patch, or dependency on Pi. */
const plugin: Plugin.Plugin = {
  id: PACKAGE_ID,
  async setup(ctx) {
    const lifecycle = new AbortController();
    const engine = createRustEngine();
    // OpenCode 2.2.5 caches language/SDK factories by provider settings, not
    // hook generation. A fresh setup must not reuse its disposed predecessor.
    const activation = randomUUID();
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    const sessions = new Set<string>();
    const auth = createCursorAuthClient();
    const workspace = ctx.location.directory ?? process.cwd();
    let inventory: CursorModel[] = [{ id: "auto", name: "Auto (Cursor)", reasoning: false, contextWindow: 200000, maxTokens: 8192 }];
    let generation = 0;
    let stopped = false;
    let iterator: AsyncIterator<unknown> | undefined;
    const track = async (registration: Promise<{ dispose(): Promise<void> }>) => { registrations.push(await registration); };

    const dispose = async () => {
      if (stopped) return;
      stopped = true;
      generation++;
      lifecycle.abort();
      void iterator?.return?.().catch(() => {});
      engine.shutdown();
      for (const registration of registrations.reverse()) await registration.dispose();
    };

    // Freeze the connection identity for each model request. Switching accounts
    // must not send a pending tool result into a different Cursor account.
    const bindAccessToken = async (): Promise<NativeModelOptions["getAccessToken"]> => {
      const env = process.env.CURSOR_ACCESS_TOKEN?.trim();
      if (env) {
        const getToken: NativeModelOptions["getAccessToken"] = async ({ signal, forceRefresh } = {}) => {
          signal?.throwIfAborted();
          if (forceRefresh) throw new Error("CURSOR_ACCESS_TOKEN cannot be refreshed automatically; supply a new token");
          return env;
        };
        return Object.assign(getToken, { scope: "env:" + createHash("sha256").update(env).digest("hex") });
      }
      const connection = await ctx.integration.connection.active(integrationID);
      if (!connection) throw new Error("Sign in to Cursor Native with /connect, or set CURSOR_ACCESS_TOKEN");
      let lastAccess: string | undefined;
      const getToken: NativeModelOptions["getAccessToken"] = async ({ signal, forceRefresh } = {}) => {
        signal?.throwIfAborted();
        const credential = await ctx.integration.connection.resolve(connection);
        signal?.throwIfAborted();
        const access = credential?.type === "oauth" ? credential.access : credential?.type === "key" ? credential.key : undefined;
        if (access) {
          // The host resolves/refreshes expiring OAuth under its credential lock.
          // 2.2.5 has no public force-refresh operation: do not return the same
          // rejected token or rotate refresh credentials outside the host store.
          if (forceRefresh && access === lastAccess) throw new Error("Cursor rejected the cached credential; reconnect Cursor Native to refresh the login");
          lastAccess = access;
          return access;
        }
        throw new Error("Cursor Native requires a Cursor access token or its own browser login, not a Cursor API key/CLI marker");
      };
      return Object.assign(getToken, { scope: "connection:" + createHash("sha256").update(JSON.stringify(connection)).digest("hex") });
    };

    const refreshCatalog = async () => {
      const current = ++generation;
      try {
        const token = await bindAccessToken();
        const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(20000)]);
        const models = JSON.parse(await engine.listModels(await token({ signal }))) as CursorModel[];
        if (stopped || current !== generation || !models.length) return;
        // Parameterized routes need a richer picker adapter; do not silently
        // advertise a route that would lose its model parameters.
        inventory = models.filter(m => !m.parameters?.length && !m.requiresMaxMode);
        if (!inventory.some(m => m.id === "auto")) inventory.unshift({ id: "auto", name: "Auto (Cursor)", reasoning: false, contextWindow: 200000, maxTokens: 8192 });
        await ctx.provider.reload();
      } catch {
        // Discovery is optional and off the startup path. Never print an auth
        // exception or an upstream payload (which may contain credentials).
      }
    };

    try {
      // Register before publishing the provider. The host's generic AISDK
      // fallback must never try downloading a made-up model package.
      await track(ctx.aisdk.hook("sdk", event => {
        if (event.model.providerID !== providerID || event.package !== PACKAGE_ID) return;
        event.sdk = { languageModel(modelId: string) {
          return createNativeModel({ modelId, workspace, bindAccessToken, engine,
            getAccessToken: async options => (await bindAccessToken())(options),
            onSession: id => sessions.add(id) });
        } };
      }, { providerID }));
      await track(ctx.aisdk.hook("language", event => {
        if (event.model.providerID !== providerID) return;
        event.language = event.sdk.languageModel(event.model.modelID ?? event.model.id);
      }, { providerID }));
      await track(ctx.integration.transform(editor => {
        editor.update(integrationID, item => { item.name = "Cursor Native"; });
        editor.method.update({ integrationID,
          method: { id: oauthMethodID, type: "oauth", label: "Sign in to Cursor (native PKCE, no CLI)" },
          async authorize() {
            const { verifier, uuid, loginUrl } = await auth.generateParams();
            const callback = auth.poll(uuid, verifier, { signal: lifecycle.signal }).then(tokens => {
              // Reuse the tested upstream expiry decoder, not a fabricated TTL.
              return import("../../../vendor/pi-cursor/src/auth/oauth.js").then(({ getTokenExpiry }) => oauthCredential({ access: tokens.accessToken, refresh: tokens.refreshToken, expires: getTokenExpiry(tokens.accessToken) }));
            });
            void callback.catch(() => {});
            return { url: loginUrl, instructions: "Sign in to the Cursor subscription account you want to use.", mode: "auto", callback };
          },
          refresh: async credential => oauthCredential(await auth.refreshToken(credential.refresh, { signal: lifecycle.signal })),
          label: () => "Cursor Native",
        });
        editor.method.update({ integrationID, method: { type: "env", names: ["CURSOR_ACCESS_TOKEN"] } });
      }));
      await track(ctx.provider.transform(editor => {
        editor.add({ info: { id: providerID, name: "Cursor Native (Rust)", activation: "enabled", integrationID, package: "aisdk:" + PACKAGE_ID, settings: { cursorNativeActivation: activation } }, models: inventory.map(catalogModel) });
      }));
      // Rust already applies bounded safe recovery. Do not multiply it by
      // host retries of fatal protocol/lifecycle failures or uncertain actions.
      await track(ctx.session.hook("retry", event => { event.decision = { retry: false }; }, { providerID }));
      await track(ctx.session.hook("model.request", async event => {
        if (event.model.providerID !== providerID) return;
        const info = await ctx.session.get({ sessionID: event.sessionID });
        event.headers[SESSION_HEADER] = event.sessionID + ":" + event.kind;
        event.headers[WORKSPACE_HEADER] = encodeURIComponent(info.location.directory ?? workspace);
      }, { providerID }));
      // Startup replays registered transforms after setup. Reloading integration
      // here can wait on this same activation and deadlock a cold host.
      if (ctx.options.discovery !== false && process.env.OPENCODE_CURSOR_OFFLINE !== "1") {
        void refreshCatalog();
        iterator = ctx.event.subscribe({ signal: lifecycle.signal })[Symbol.asyncIterator]();
        void (async () => {
          while (!stopped) {
            const event = await iterator!.next();
            if (event.done || stopped) return;
            const value = event.value as { type?: string };
            if (value.type === "credential.updated" || value.type === "credential.switched") void refreshCatalog();
          }
        })().catch(() => {});
      }
      return dispose;
    } catch (error) {
      await dispose();
      throw error;
    }
  },
};
export default plugin;
