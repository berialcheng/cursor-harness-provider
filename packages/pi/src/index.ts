import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { PiRustRuntime, type RuntimeDependencies } from "./runtime.js";
import { CursorAuth } from "./auth/index.js";
import { AGENT_URL, CURSOR_NATIVE_API, PROVIDER_ID } from "./constants.js";
import { abortable, isRecord, safeError } from "./security.js";
import { COMPAT_OWNER_FIELD, installCompatDispatcher, registerCompatOwner, type CompatRegistry } from "./compat.js";

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
interface RecoveryArgs { scope?: string; select: boolean; help: boolean; apply: boolean; confirmed: boolean }
function recoveryArgs(args: string, cache: boolean): RecoveryArgs {
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  const result: RecoveryArgs = { select: false, help: false, apply: false, confirmed: false };
  const seen = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (seen.has(word)) throw new Error("Duplicate recovery option");
    seen.add(word);
    if (word === "--scope") {
      const scope = words[++i];
      if (!scope || !/^[a-fA-F0-9]{64}$/.test(scope)) throw new Error("--scope requires an exact full 64-hex known scope");
      result.scope = scope;
    } else if (word === "--select") result.select = true;
    else if (word === "--help") result.help = true;
    else if (cache && word === "--apply") result.apply = true;
    else if (word === (cache ? "--confirm-prune" : "--confirm-discard")) result.confirmed = true;
    else throw new Error("Unsupported recovery option; use --help");
  }
  if ((result.scope && result.select) || (result.help && words.length !== 1)) throw new Error("Use --scope or --select, or --help alone");
  if (result.confirmed && (!result.scope || (cache && !result.apply))) throw new Error("Explicit confirmation requires --scope (and --apply for cache pruning)");
  if (result.apply && !result.scope && !result.select) throw new Error("--apply requires --scope or --select");
  return result;
}
/** Do not print arbitrary native reports, paths, or provider payloads. */
function cacheCounts(value: unknown): string {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return ""; } }
  if (!isRecord(value)) return "";
  return ["scanned", "skipped", "expired", "applied", "reclaimableBytes", "committedBytes", "limitBytes", "records", "limitRecords", "directoryEntries", "scanLimitEntries"]
    .flatMap(key => (typeof value[key] === "number" && Number.isFinite(value[key])) || (key === "applied" && typeof value[key] === "boolean")
      ? [`${key}=${value[key]}`] : []).join(" ");
}
const CACHE_ROOT_NOTICE = "The known scope supplies the known cache root, not a scope-only filter. Maintenance is root-wide; apply can prune other expired records, including other conversations in that root. Locked, active, or corrupt records are skipped; all uncertainty tombstones are retained. No actions are undone; no DSO/library cleanup.";
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

/** Injectable registration; the compat dispatcher is inert until a session owns a registration. No startup I/O. */
export function registerCursorNative(pi: ExtensionAPI, deps: RuntimeDependencies & { compatRegistry?: CompatRegistry } = {}): void {
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
  let compatId = randomUUID();
  const env = () => deps.env?.() ?? process.env;
  const config = (): ProviderConfig => {
    // BTW and other children retain this object. Its callbacks must retain this
    // lifecycle, not borrow a replacement parent's runtime or owner provenance.
    const ownedRuntime = runtime, owner = compatId;
    return {
      name: "Cursor (Rust)", baseUrl: AGENT_URL, api: CURSOR_NATIVE_API,
      apiKey: "$CURSOR_ACCESS_TOKEN", models: ownedRuntime.definitions().map(model => ({ ...model, [COMPAT_OWNER_FIELD]: owner })),
      streamSimple: (model, context, options) => ownedRuntime.streamSimple(model, context, options),
      refreshModels: async context => {
        if (runtime !== ownedRuntime || compatId !== owner || ownedRuntime.isClosed) throw new Error("Cursor provider registration is stale");
        const models = await ownedRuntime.refreshModels(context);
        if (runtime !== ownedRuntime || compatId !== owner) throw new Error("Pi session changed during Cursor model refresh");
        return models.map(model => ({ ...model, [COMPAT_OWNER_FIELD]: owner }));
      },
      oauth: {
        name: "Cursor", isSubscription: true,
        login: callbacks => auth.login(callbacks, env()),
        refreshToken: (credential, signal) => auth.refreshCredential(credential, signal, env()),
        // Return the real token to Pi's request boundary, not an API-name sentinel.
        getApiKey: credential => auth.remember(credential),
      },
    };
  };
  pi.registerProvider(PROVIDER_ID, config());
  installCompatDispatcher(deps.compatRegistry);
  let releaseCompat: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    releaseCompat?.(); releaseCompat = undefined;
    if (liveContext || runtime.isClosed) {
      runtime.shutdown(); runtime = createRuntime(); compatId = randomUUID();
      pi.registerProvider(PROVIDER_ID, config());
    }
    runtime.setSession({ sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd });
    liveContext = ctx;
    const ownedRuntime = runtime;
    releaseCompat = registerCompatOwner({ id: compatId, sessionId: ctx.sessionManager.getSessionId(), runtime: ownedRuntime,
      resolveAuth: async signal => {
        signal.throwIfAborted();
        if (liveContext !== ctx || runtime !== ownedRuntime || ownedRuntime.isClosed) throw new Error("Cursor compat session owner is stale");
        const resolved = await abortable(ctx.modelRegistry.getProviderAuth(PROVIDER_ID), signal);
        signal.throwIfAborted();
        if (liveContext !== ctx || runtime !== ownedRuntime || ownedRuntime.isClosed) throw new Error("Cursor compat session owner changed during authentication");
        return { apiKey: resolved?.auth.apiKey, env: resolved?.env };
      },
    }, deps.compatRegistry);
  });
  pi.on("session_shutdown", () => { releaseCompat?.(); releaseCompat = undefined; liveContext = undefined; runtime.shutdown(); });

  // Command contexts are distinct from the session_start context. Check their
  // public identity, plus the captured lifecycle/owner, at every async boundary.
  const commandRuntime = (ctx: ExtensionCommandContext) => {
    const ownedRuntime = runtime, lifecycle = liveContext, owner = compatId;
    const sessionId = ctx.sessionManager.getSessionId(), cwd = ctx.cwd;
    const check = () => {
      ctx.signal?.throwIfAborted();
      if (!lifecycle || liveContext !== lifecycle || runtime !== ownedRuntime || compatId !== owner || ownedRuntime.isClosed ||
          ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd ||
          !ownedRuntime.ownsSession(ctx.sessionManager.getSessionId(), ctx.cwd)) throw new Error("Cursor command session owner is stale or unavailable");
    };
    check();
    return { runtime: ownedRuntime, check };
  };
  const commandError = (ctx: ExtensionCommandContext, prefix: string, error: unknown, secrets: string[] = [], check?: () => void) => {
    // Rejected awaits also cross an ownership boundary. The host may invalidate
    // ctx.ui after replacement; never borrow another context to report a failure.
    try { check?.(); output(ctx, `${prefix}: ${safeError(error, secrets)}`, true); } catch { /* stale/cancelled host context */ }
  };
  const recoveryCommand = (cache: boolean) => async (args: string, ctx: ExtensionCommandContext) => {
    let check: (() => void) | undefined;
    try {
      const owned = commandRuntime(ctx); check = owned.check;
      const options = recoveryArgs(args, cache);
      const scopes = owned.runtime.recoveryScopes();
      if (options.help || (!options.scope && !options.select)) {
        output(ctx, [cache ? "Cursor cache (root-wide; dry run by default)" : "Cursor recovery (list only; no reset requested)",
          ...scopes.map(item => safeError(`${item.scope} model=${item.modelId} kind=${item.kind} state=${item.state} activeRequests=${item.activeRequests} pendingStart=${item.pendingStart} mayHaveActions=${item.mayHaveActions}`)),
          ...(scopes.length ? [] : ["No known scopes in this lifecycle."]),
          cache ? "Use --scope <full 64-hex> to supply the known root. --apply prunes root-wide; headless --apply --confirm-prune explicitly confirms root-wide pruning."
            : "Use --scope <full 64-hex>; headless reset also requires --confirm-discard.",
          "Use --select for a known-scope UI picker; no default scope or cache root is guessed.",
          cache ? CACHE_ROOT_NOTICE
            : "Tools may already have effects. Discarding recovery does not undo them; no automatic retry."].join("\n"));
        return;
      }
      let scope = options.scope;
      if (options.select) {
        if (!ctx.hasUI) throw new Error("--select requires UI; supply an exact --scope instead");
        owned.check();
        scope = await ctx.ui.select(cache ? "Cursor: choose a known scope to anchor root-wide cache maintenance" : "Cursor: choose an exact known scope", scopes.map(item => item.scope), { signal: ctx.signal });
        owned.check();
        if (scope === undefined) return;
      }
      const known = () => {
        owned.check();
        if (!scope || !/^[a-fA-F0-9]{64}$/.test(scope) || !scopes.some(item => item.scope === scope) ||
            !owned.runtime.recoveryScopes().some(item => item.scope === scope)) throw new Error("Unknown scope in this Cursor lifecycle; no action taken");
        return scope;
      };
      known();
      if (!cache || options.apply) {
        if (ctx.hasUI) {
          owned.check();
          const confirmed = await ctx.ui.confirm(cache ? "Prune Cursor cache root-wide?" : "Discard Cursor recovery?",
            cache ? `Known root anchored by scope ${scope}\n${CACHE_ROOT_NOTICE}`
              : `Scope ${scope}\nTools may already have effects. Discarding recovery does not undo them. This does not retry the request.`,
            { signal: ctx.signal });
          owned.check();
          if (!confirmed) return;
        } else if (!options.confirmed) throw new Error(cache ? "Headless root-wide pruning requires --scope to supply the known root and --apply --confirm-prune to confirm pruning across that root" : "Headless reset requires --scope and --confirm-discard");
      }
      const fullScope = known();
      if (cache) {
        owned.check();
        const report = await owned.runtime.maintainCache(fullScope, options.apply, ctx.signal);
        owned.check();
        output(ctx, [`Cursor cache root-wide ${options.apply ? "apply" : "dry run"} completed (known root anchored by scope ${fullScope}).`, cacheCounts(report),
          CACHE_ROOT_NOTICE, ...(options.apply ? [] : ["No pruning requested; use --apply with confirmation to prune root-wide (--confirm-prune in headless mode)."])].filter(Boolean).join("\n"));
      } else {
        owned.check();
        await owned.runtime.resetScope(fullScope, ctx.signal);
        owned.check();
        output(ctx, `Cursor recovery discarded for ${fullScope}. Tool effects are not undone; no request retried.`);
      }
    } catch (error) { commandError(ctx, "Cursor recovery unavailable", error, [], check); }
  };
  pi.registerCommand("cursor.reset", { description: "List recovery scopes or explicitly discard one known scope (never undo tools or retry)", handler: recoveryCommand(false) });
  pi.registerCommand("cursor.cache", { description: "Inspect the known root supplied by a scope; root-wide --apply requires confirmation and retains all uncertainty tombstones", handler: recoveryCommand(true) });
  pi.registerCommand("cursor.models", {
    description: "Discover exact supported Cursor models using the Rust RPC (--cached for current session list)",
    handler: async (args, ctx) => {
      let check: (() => void) | undefined;
      try {
        const owned = commandRuntime(ctx); check = owned.check;
        if (!args.split(/\s+/).includes("--cached")) {
          owned.check();
          const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: true, force: true, signal: ctx.signal });
          owned.check();
          const error = result.errors.get(PROVIDER_ID);
          if (error) throw error;
          if (result.aborted) throw new Error("Cursor model discovery cancelled");
        }
        owned.check();
        const lines = owned.runtime.definitions().map(model => `${model.id}  ${model.name}  input=${model.input.join(",")}`);
        output(ctx, ["Cursor models (direct IDs and advertised parameter combinations; Max Mode ≠ reasoning max)", ...lines,
          "Images: inline host attachments only where advertised; path-only screenshots require an authorized host read/attachment.",
          "Costs in catalog are unknown (zero placeholders), not a free-use/quota claim."].join("\n"));
      } catch (error) { commandError(ctx, "Cursor model discovery unavailable", error, [], check); }
    },
  });
  pi.registerCommand("cursor.doctor", {
    description: "Show sanitized Rust Cursor provider capabilities (no credential lookup or live request)",
    handler: async (_args, ctx) => {
      try { const owned = commandRuntime(ctx); output(ctx, owned.runtime.doctor()); }
      catch (error) { commandError(ctx, "Cursor diagnostics unavailable", error); }
    },
  });
  pi.registerCommand("cursor.usage", {
    description: "Read Cursor usage via Rust RPC, or report the binding capability gap explicitly",
    handler: async (_args, ctx) => {
      let token = "", check: (() => void) | undefined;
      try {
        const owned = commandRuntime(ctx); check = owned.check;
        owned.check();
        const access = ctx.signal
          ? await abortable(ctx.modelRegistry.getProviderAuth(PROVIDER_ID), ctx.signal)
          : await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
        owned.check();
        token = access?.auth.apiKey ?? "";
        owned.check();
        const usage = await owned.runtime.usage(access?.auth.apiKey, ctx.signal, access?.env);
        owned.check();
        output(ctx, formatUsage(usage));
      } catch (error) { commandError(ctx, "Cursor usage unavailable", error, [token], check); }
    },
  });
}
export default function cursorNative(pi: ExtensionAPI): void { registerCursorNative(pi); }
