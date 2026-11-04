/** PKCE auth ported from pi-cursor 1.4.39 (MIT, Rahul Arya), itself based on
 * Ephraim Duncan's opencode-cursor. No inference/transport code is reused.
 * See ../../THIRD_PARTY_NOTICES.md. All I/O is lazy and injectable. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { abortable, abortError, isRecord } from "../security.js";

export interface OAuthDependencies {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pkce?: () => { verifier: string; challenge: string; uuid: string };
  now?: () => number;
}
export function tokenExpiry(token: string, now = Date.now()): number {
  try {
    const value: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (isRecord(value) && typeof value.exp === "number" && Number.isFinite(value.exp)) return value.exp * 1000 - 300000;
  } catch { /* opaque access token */ }
  return now + 3600000;
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function tokens(value: unknown): { access: string; refresh?: string } {
  if (!isRecord(value) || typeof value.accessToken !== "string" || !value.accessToken.trim() ||
      (value.refreshToken !== undefined && typeof value.refreshToken !== "string")) throw new Error("Cursor returned an invalid OAuth token response");
  return { access: value.accessToken, refresh: typeof value.refreshToken === "string" ? value.refreshToken : undefined };
}
export function createOAuthClient(deps: OAuthDependencies = {}) {
  const now = deps.now ?? Date.now;
  const request = async (url: string, init: RequestInit, signal: AbortSignal): Promise<Response> => {
    signal.throwIfAborted();
    return abortable((deps.fetch ?? globalThis.fetch)(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }), signal);
  };
  return {
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const signal = callbacks.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const params = deps.pkce?.() ?? (() => {
        const verifier = randomBytes(96).toString("base64url");
        return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), uuid: randomUUID() };
      })();
      const query = new URLSearchParams({ challenge: params.challenge, uuid: params.uuid, mode: "login", redirectTarget: "cli" });
      // The Cursor page owns sign-in/sign-up. Do not invent a separate signup endpoint.
      callbacks.onAuth({ url: `https://cursor.com/loginDeepControl?${query}`, instructions: "Sign in or create an account in Cursor. Cancel here to stop polling." });
      let delay = 1000, errors = 0;
      for (let i = 0; i < 150; i++) {
        await abortable((deps.sleep ?? sleep)(delay, signal), signal);
        signal.throwIfAborted();
        try {
          const poll = new URLSearchParams({ uuid: params.uuid, verifier: params.verifier });
          const response = await request(`https://api2.cursor.sh/auth/poll?${poll}`, {}, signal);
          if (response.status === 404) { errors = 0; delay = Math.min(delay * 1.2, 10000); continue; }
          if (!response.ok) throw new Error(`Cursor authentication polling failed (HTTP ${response.status})`);
          const pair = tokens(await abortable(response.json(), signal));
          if (!pair.refresh) throw new Error("Cursor returned no OAuth refresh token");
          return { access: pair.access, refresh: pair.refresh, expires: tokenExpiry(pair.access, now()) };
        } catch {
          signal.throwIfAborted();
          if (++errors >= 3) throw new Error("Cursor authentication polling failed repeatedly; retry /login cursor");
        }
      }
      throw new Error("Cursor authentication polling timed out");
    },
    async refresh(refresh: string, signal: AbortSignal): Promise<OAuthCredentials> {
      if (!refresh) throw new Error("No Cursor refresh token; run /login cursor");
      const response = await request("https://api2.cursor.sh/auth/exchange_user_api_key", {
        method: "POST", headers: { Authorization: `Bearer ${refresh}`, "Content-Type": "application/json" }, body: "{}",
      }, signal);
      // Never include a response body or a credential in an error.
      if (!response.ok) throw new Error(`Cursor OAuth refresh failed (HTTP ${response.status}); run /login cursor`);
      const pair = tokens(await abortable(response.json(), signal));
      return { access: pair.access, refresh: pair.refresh || refresh, expires: tokenExpiry(pair.access, now()) };
    },
  };
}
export type OAuthClient = ReturnType<typeof createOAuthClient>;
