import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { Api, Model, SimpleStreamOptions, TranscriptContext, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CURSOR_NATIVE_API, PROVIDER_ID } from "./constants.js";
import type { PiRustRuntime } from "./runtime.js";

/** Public host module view, which can differ from compiled ESM peer resolution. */
export interface CompatRegistry {
  getApiProvider: typeof getApiProvider;
  registerApiProvider: typeof registerApiProvider;
}
export interface CompatAccess { apiKey?: string; env?: Record<string, string> }
export const COMPAT_OWNER_FIELD = "cursorNativeCompatOwner";
export interface CompatOwner {
  id: string;
  sessionId: string;
  runtime: PiRustRuntime;
  resolveAuth(signal: AbortSignal): Promise<CompatAccess>;
}
type Registration = CompatOwner;
interface DispatcherState { owners: Map<string, Registration> }
// Reloaded extension bundles share only lifecycle registrations, never cached credentials.
const key = Symbol.for("cursor-harness-provider.pi.compat.v1");
const shared = globalThis as typeof globalThis & { [key]?: DispatcherState };
const state = shared[key] ??= { owners: new Map() };

function dispatch(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
  options.signal?.throwIfAborted();
  if (model.api !== CURSOR_NATIVE_API || model.provider !== PROVIDER_ID) throw new Error("Cursor compat provider/API mismatch");
  const owners = [...state.owners.values()];
  if (!owners.length) throw new Error("Cursor compat has no active session owner");
  const sessionId = options.sessionId?.trim();
  const exact = sessionId ? owners.filter(owner => owner.sessionId === sessionId) : [];
  const provenance = (model as Model<Api> & { [COMPAT_OWNER_FIELD]?: unknown })[COMPAT_OWNER_FIELD];
  let owner: Registration;
  if (provenance !== undefined) {
    if (typeof provenance !== "string" || !state.owners.has(provenance)) throw new Error("Cursor compat model owner is stale or unknown");
    owner = state.owners.get(provenance)!;
    if (exact.length && !exact.includes(owner)) throw new Error("Cursor compat model and parent session owner do not match");
  } else {
    // A hand-built/old model needs an exact live parent, not a last/unique-owner
    // guess. A stale child ID or old model must never borrow a newer host's auth.
    if (exact.length !== 1) throw new Error(exact.length > 1 || owners.length > 1
      ? "Cursor compat owner is ambiguous; select a live host model or pass an exact parent sessionId"
      : "Cursor compat owner is stale or unknown; select a live host model or pass its exact parent sessionId");
    owner = exact[0]!;
  }
  if (owner.runtime.isClosed) throw new Error("Cursor compat session owner is stale");
  const resolveAuth = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (state.owners.get(owner.id) !== owner || owner.runtime.isClosed) throw new Error("Cursor compat session owner is stale");
    const access = await owner.resolveAuth(signal);
    signal.throwIfAborted();
    if (state.owners.get(owner.id) !== owner || owner.runtime.isClosed) throw new Error("Cursor compat session owner changed during authentication");
    return access;
  };
  return owner.runtime.streamCompat(model, context, options, owner.id, resolveAuth);
}

/** Register ONLY the new API. Keep the dispatcher installed after shutdown so stale calls fail clearly. */
export function installCompatDispatcher(hostRegistry?: CompatRegistry): void {
  // No persistent registry list: each lifecycle reinstalls into both public views.
  const installed = new Set<CompatRegistry["registerApiProvider"]>();
  for (const registry of [{ getApiProvider, registerApiProvider }, ...(hostRegistry ? [hostRegistry] : [])]) {
    if (installed.has(registry.registerApiProvider)) continue;
    installed.add(registry.registerApiProvider);
    registry.registerApiProvider({ api: CURSOR_NATIVE_API, stream: dispatch, streamSimple: dispatch }, "cursor-harness-provider/pi/compat");
  }
}
export function registerCompatOwner(owner: CompatOwner, hostRegistry?: CompatRegistry): () => void {
  installCompatDispatcher(hostRegistry);
  if (state.owners.has(owner.id)) throw new Error("Cursor compat owner is already registered");
  const registration: Registration = { ...owner };
  state.owners.set(registration.id, registration);
  return () => {
    if (state.owners.get(registration.id) !== registration) return;
    state.owners.delete(registration.id);
  };
}
