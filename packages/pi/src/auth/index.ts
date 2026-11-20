import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { withDeadline, type DeadlineOptions } from "@cursor-harness-provider/native/lifecycle";
import { accountPartition, abortable, abortError } from "../security.js";
import { createOAuthClient, tokenExpiry, type OAuthClient, type OAuthDependencies } from "./oauth.js";
import { createSystemResolver, systemCredentialsAllowed, type SystemDependencies, type SystemResolver } from "./system.js";

/** Resolve through the live Pi model registry; Pi owns expiry refresh and its storage lock. */
export type ResolveAuth = (signal: AbortSignal) => Promise<string | undefined>;
export interface TokenBinding {
  accessToken: string;
  account: string;
  source: string;
  refresh(signal: AbortSignal): Promise<string>;
}
export interface AuthDependencies {
  oauth?: OAuthClient;
  oauthDependencies?: OAuthDependencies;
  system?: SystemResolver;
  systemDependencies?: SystemDependencies;
  resolveAuth?: ResolveAuth;
}

function authDeadline(env: NodeJS.ProcessEnv, signal: AbortSignal): DeadlineOptions {
  const configured = Number(env.PI_CURSOR_AUTH_TIMEOUT_MS?.trim() || 25000);
  return { signal, timeoutMs: Number.isFinite(configured) ? Math.max(1, Math.min(30000, configured)) : 25000,
    code: "CURSOR_AUTH_TIMEOUT", message: "Cursor authentication timed out; run /login cursor" };
}

function importedExpiry(access: string): number {
  // Pi already refreshes within five minutes. A five-minute imported TTL was
  // therefore expired on every getAuth(), repeatedly rotating the OS credential.
  const now = Date.now(), expires = tokenExpiry(access, now, 0);
  if (expires <= now + 301000) throw new Error("Cursor system access token expires too soon; renew it in Cursor or use browser /login cursor");
  return expires;
}

/** Pi owns persistent OAuth storage. No auth.json access or shadow rotating credential cache. */
export class CursorAuth {
  private readonly oauth: OAuthClient;
  private readonly system: SystemResolver;
  private readonly resolveAuth: ResolveAuth | undefined;
  constructor(deps: AuthDependencies = {}) {
    this.oauth = deps.oauth ?? createOAuthClient(deps.oauthDependencies);
    this.system = deps.system ?? createSystemResolver(this.oauth, deps.systemDependencies);
    this.resolveAuth = deps.resolveAuth;
  }
  // Compatibility with the host's getApiKey hook; never retain a second credential pair.
  clear(): void {}
  remember(credentials: OAuthCredentials): string { return credentials.access; }
  async login(callbacks: OAuthLoginCallbacks, env: NodeJS.ProcessEnv): Promise<OAuthCredentials> {
    const signal = callbacks.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const methods = [{ id: "browser", label: "Browser sign-in / sign up" },
      ...(systemCredentialsAllowed(env.PI_CURSOR_SYSTEM_CREDENTIALS) ? [{ id: "system", label: "Reuse Cursor CLI / IDE credentials (read-only)" }] : [])];
    const selection = callbacks.onSelect ? await abortable(callbacks.onSelect({ message: "Cursor login method", options: methods }), signal) : "browser";
    signal.throwIfAborted();
    if (!selection) throw abortError();
    let credential: OAuthCredentials;
    if (selection === "browser") credential = await abortable(this.oauth.login({ ...callbacks, signal }), signal);
    else if (selection === "system" && methods.some(method => method.id === "system")) {
      const result = await abortable(this.system(env, signal, false, true), signal);
      if (!result) throw new Error("No permitted Cursor CLI/IDE credential; use browser sign-in");
      // An imported access token has no reusable refresh credential. Re-resolve on expiry.
      credential = { access: result.accessToken, refresh: "", expires: importedExpiry(result.accessToken), cursorNativeSystem: true };
    } else throw new Error("Unknown or disabled Cursor login method");
    signal.throwIfAborted();
    return credential;
  }
  /** Raw OAuth callback ONLY for Pi's locked, persistent credential refresh transaction. */
  async refreshCredential(credentials: OAuthCredentials, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<OAuthCredentials> {
    return withDeadline(async boundedSignal => {
      let updated: OAuthCredentials;
      if (credentials.cursorNativeSystem === true) {
        if (!systemCredentialsAllowed(env.PI_CURSOR_SYSTEM_CREDENTIALS)) throw new Error("Cursor system credentials are disabled; run /login cursor");
        // Re-read the OS owner's latest access token. Do not force rotation of an
        // otherwise usable OS pair merely because Pi is checking its import.
        const result = await this.system(env, boundedSignal, false, true);
        boundedSignal.throwIfAborted();
        if (!result) throw new Error("Cursor system credentials cannot refresh; run /login cursor");
        updated = { ...credentials, access: result.accessToken, expires: importedExpiry(result.accessToken) };
      } else {
        const result = await this.oauth.refresh(credentials.refresh, boundedSignal);
        boundedSignal.throwIfAborted();
        updated = result;
      }
      if (accountPartition(updated.access) !== accountPartition(credentials.access)) throw new Error("Cursor account changed during refresh; start a new request");
      return updated;
    }, authDeadline(env, signal));
  }
  async bind(apiKey: string | undefined, env: NodeJS.ProcessEnv, signal: AbortSignal, resolveAuth = this.resolveAuth): Promise<TokenBinding> {
    return withDeadline(async boundedSignal => {
      // A host-supplied credential is authoritative. Never harvest another account after rejection.
      const hostToken = apiKey?.trim();
      const result = hostToken ? { accessToken: hostToken, source: "Pi resolved credential" }
        : await this.system(env, boundedSignal, false, true);
      boundedSignal.throwIfAborted();
      if (!result?.accessToken) throw new Error("No Cursor access token; run /login cursor");
      const accessToken = result.accessToken;
      const account = accountPartition(accessToken);
      let currentToken = accessToken;
      return {
        accessToken, account, source: result.source,
        refresh: refreshSignal => withDeadline(async refreshBound => {
          let refreshed: string | undefined;
          if (hostToken) {
            if (!resolveAuth) throw new Error("Pi canonical auth resolution unavailable; run /login cursor");
            // Do not call refreshCredential here: rotating outside Pi's lock can invalidate its stored pair.
            refreshed = await resolveAuth(refreshBound);
            refreshBound.throwIfAborted();
          } else {
            // Re-read only the external owner's current access token. Never rotate its refresh pair.
            const result = await this.system(env, refreshBound, false, true);
            refreshBound.throwIfAborted();
            refreshed = result?.accessToken;
          }
          if (!refreshed?.trim()) throw new Error("Cursor credential refresh unavailable; run /login cursor");
          refreshed = refreshed.trim();
          if (accountPartition(refreshed) !== account) throw new Error("Cursor account changed during request refresh; refusing to switch accounts");
          if (refreshed === currentToken) throw new Error("Pi returned the same rejected Cursor access token; run /login cursor");
          currentToken = refreshed;
          return refreshed;
        }, authDeadline(env, refreshSignal)),
      };
    }, authDeadline(env, signal));
  }
}
