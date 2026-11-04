import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { PiRustRuntime, type RuntimeDependencies } from "./runtime.js";
import { CursorAuth } from "./auth/index.js";
import { AGENT_URL, CURSOR_NATIVE_API, PROVIDER_ID } from "./constants.js";
import { abortable, isRecord, safeError } from "./security.js";

export { PiRustRuntime } from "./runtime.js";
export { toNativeTranscript, inlineImage } from "./transcript.js";
export { CursorAuth } from "./auth/index.js";
export { CursorCatalog } from "./models.js";
export { PROVIDER_ID, CURSOR_NATIVE_API } from "./constants.js";

function output(ctx: ExtensionCommandContext, text: string, error = false): void {
  if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
  else if (error) console.error(text);
  else console.log(text);
}
/** Display only explicit provider-reported numerical fields, never infer a plan/quota/unit. */
export function formatUsage(value: unknown): string {
  if (!isRecord(value)) throw new Error("Rust usage RPC returned an invalid response");
  const lines = ["Cursor usage (Rust RPC; provider-reported values)"];
  const visit = (object: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const key of ["planUsage", "spendLimitUsage", "individualUsage", "teamUsage", "plan", "onDemand", "breakdown"]) {
      const child = object[key]; if (depth < 3 && isRecord(child)) visit(child, prefix + key + ".", depth + 1);
    }
    for (const key of ["used", "limit", "remaining", "includedSpend", "included", "bonus", "total", "totalPercentUsed", "autoPercentUsed", "apiPercentUsed"]) {
      const v = object[key]; if (typeof v === "number" && Number.isFinite(v)) lines.push(`${prefix}${key}=${v}`);
    }
    if (typeof object.isUnlimited === "boolean") lines.push(`${prefix}isUnlimited=${object.isUnlimited}`);
  };
  visit(value, "", 0);
  if (lines.length === 1) throw new Error("Rust usage RPC returned no recognized usage fields; quota is unknown");
  return lines.join("\n");
}

/** Injectable registration for fixture tests. No global API registry, no startup auth/file/network work. */
export function registerCursorNative(pi: ExtensionAPI, deps: RuntimeDependencies = {}): void {
  const auth = deps.auth ?? new CursorAuth();
  let liveContext: ExtensionContext | undefined;
  const resolveAuth = async (signal: AbortSignal): Promise<string | undefined> => {
    signal.throwIfAborted();
    const ctx = liveContext;
    if (!ctx) throw new Error("Pi session auth resolver unavailable; run /login cursor");
    // Pi performs normal expiry refresh inside its canonical locked auth store.
    // getProviderAuth has no signal argument: stop using its result after cancellation/replacement.
    const resolved = await abortable(ctx.modelRegistry.getProviderAuth(PROVIDER_ID), signal);
    signal.throwIfAborted();
    if (liveContext !== ctx) throw new Error("Pi session changed during Cursor credential resolution");
    return resolved?.auth.apiKey;
  };
  const createRuntime = () => new PiRustRuntime({ ...deps, auth, resolveAuth: deps.resolveAuth ?? resolveAuth });
  let runtime = createRuntime();
  const env = () => deps.env?.() ?? process.env;
  const config = (): ProviderConfig => ({
    name: "Cursor (Rust)", baseUrl: AGENT_URL, api: CURSOR_NATIVE_API,
    apiKey: "$CURSOR_ACCESS_TOKEN", models: runtime.definitions(),
    streamSimple: (model, context, options) => runtime.streamSimple(model, context, options),
    async refreshModels(context) {
      if (!context.allowNetwork || context.signal.aborted) return runtime.definitions();
      const credential = context.credential;
      if (credential?.type === "oauth") auth.remember(credential);
      const token = credential?.type === "oauth" ? credential.access : credential?.key;
      const rawEnv = credential?.env;
      const scopedEnv = isRecord(rawEnv) ? Object.fromEntries(Object.entries(rawEnv).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : undefined;
      return runtime.discover(token, context.signal, scopedEnv, context.baseUrl);
    },
    oauth: {
      name: "Cursor", isSubscription: true,
      login: callbacks => auth.login(callbacks, env()),
      refreshToken: (credential, signal) => auth.refreshCredential(credential, signal, env()),
      // Return the real token to Pi's request boundary, not an API-name sentinel.
      getApiKey: credential => auth.remember(credential),
    },
  });
  pi.registerProvider(PROVIDER_ID, config());
  pi.on("session_start", (_event, ctx) => {
    if (runtime.isClosed) runtime = createRuntime();
    runtime.setSession({ sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd });
    liveContext = ctx;
  });
  pi.on("session_shutdown", () => { liveContext = undefined; runtime.shutdown(); });

  const commandAuth = async (ctx: ExtensionCommandContext) => {
    const resolved = ctx.signal
      ? await abortable(ctx.modelRegistry.getProviderAuth(PROVIDER_ID), ctx.signal)
      : await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
    return { token: resolved?.auth.apiKey, env: resolved?.env };
  };
  pi.registerCommand("cursor.models", {
    description: "Discover exact supported Cursor models using the Rust RPC (--cached for current session list)",
    handler: async (args, ctx) => {
      try {
        if (!args.split(/\s+/).includes("--cached")) {
          const access = await commandAuth(ctx);
          await runtime.discover(access.token, ctx.signal, access.env);
          pi.registerProvider(PROVIDER_ID, config());
        }
        const lines = runtime.definitions().map(model => `${model.id}  ${model.name}  input=${model.input.join(",")}`);
        output(ctx, ["Cursor models (no synthetic Max/parameterized models)", ...lines,
          "Costs in catalog are unknown (zero placeholders), not a free-use/quota claim."].join("\n"));
      } catch (error) { output(ctx, `Cursor model discovery unavailable: ${safeError(error)}`, true); }
    },
  });
  pi.registerCommand("cursor.doctor", {
    description: "Show sanitized Rust Cursor provider capabilities (no credential lookup or live request)",
    handler: async (_args, ctx) => { output(ctx, runtime.doctor()); },
  });
  pi.registerCommand("cursor.usage", {
    description: "Read Cursor usage via Rust RPC, or report the binding capability gap explicitly",
    handler: async (_args, ctx) => {
      try {
        const access = await commandAuth(ctx);
        output(ctx, formatUsage(await runtime.usage(access.token, ctx.signal, access.env)));
      } catch (error) { output(ctx, `Cursor usage unavailable: ${safeError(error)}`, true); }
    },
  });
}
export default function cursorNative(pi: ExtensionAPI): void { registerCursorNative(pi); }
