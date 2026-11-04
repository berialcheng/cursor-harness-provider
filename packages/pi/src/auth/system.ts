/** Read-only CLI/IDE credential reuse, ported from pi-cursor 1.4.39 (MIT,
 * Rahul Arya). Never invoked at import/extension-factory time. No CLI inference.
 * See ../../THIRD_PARTY_NOTICES.md. Tests inject both readers. */
import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { abortable, isRecord } from "../security.js";
import { tokenExpiry, type OAuthClient } from "./oauth.js";

export interface StoredTokens { accessToken?: string; refreshToken?: string }
export interface SystemToken { accessToken: string; source: string }
export interface SystemDependencies {
  keychain?: (signal: AbortSignal) => Promise<StoredTokens>;
  ide?: (env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<StoredTokens>;
  now?: () => number;
}
/** Preserve upstream default-allow policy and explicit opt-out; unknown values fail closed. */
export function systemCredentialsAllowed(value: string | undefined): boolean {
  return !value?.trim() || /^(1|true|on|allow)$/i.test(value.trim());
}
export function windowsUsernameFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const user = /\/Users\/([^/]+)/i.exec(env.USERPROFILE?.replace(/\\/g, "/") ?? "")?.[1] ?? env.USERNAME;
  return user && !/[\\/\x00]/.test(user) && !user.startsWith(".") && !["Public", "Default"].includes(user) ? user : undefined;
}
async function keychain(signal: AbortSignal): Promise<StoredTokens> {
  if (platform() !== "darwin") return {};
  const read = (service: string) => new Promise<string | undefined>(resolve => {
    execFile("security", ["find-generic-password", "-s", service, "-a", "cursor-user", "-w"],
      { encoding: "utf8", timeout: 2000, signal }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
  const [accessToken, refreshToken] = await Promise.all([read("cursor-access-token"), read("cursor-refresh-token")]);
  return { accessToken, refreshToken };
}
async function ide(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<StoredTokens> {
  signal.throwIfAborted();
  let Database: (typeof import("node:sqlite"))["DatabaseSync"];
  try { Database = (await import("node:sqlite")).DatabaseSync; } catch { return {}; }
  const home = homedir();
  const paths = platform() === "darwin" ? [join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")]
    : platform() === "win32" ? (env.APPDATA ? [join(env.APPDATA, "Cursor/User/globalStorage/state.vscdb")] : [])
      : [join(env.XDG_CONFIG_HOME || join(home, ".config"), "Cursor/User/globalStorage/state.vscdb")];
  if (platform() === "linux" && (env.WSL_DISTRO_NAME || env.WSL_INTEROP)) {
    const user = windowsUsernameFromEnv(env);
    if (user) paths.push(join("/mnt/c/Users", user, "AppData/Roaming/Cursor/User/globalStorage/state.vscdb"));
  }
  let fallback: StoredTokens = {};
  for (const path of paths) {
    signal.throwIfAborted();
    try {
      const db = new Database(path, { readOnly: true });
      let pair: StoredTokens;
      try {
        const read = (name: string): string | undefined => {
          const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/" + name);
          return isRecord(row) && typeof row.value === "string" ? row.value.trim() || undefined : undefined;
        };
        pair = { accessToken: read("accessToken"), refreshToken: read("refreshToken") };
      } finally { db.close(); }
      if (pair.accessToken && tokenExpiry(pair.accessToken) > Date.now()) return pair;
      if (!fallback.refreshToken && pair.refreshToken) fallback = pair;
    } catch { /* absent/locked profile */ }
  }
  return fallback;
}
export function createSystemResolver(oauth: OAuthClient, deps: SystemDependencies = {}) {
  // Session-only hashed backoff. No credential/cache files are written.
  const failures = new Map<string, number>();
  const now = deps.now ?? Date.now;
  return async (env: NodeJS.ProcessEnv, signal: AbortSignal, forceRefresh = false): Promise<SystemToken | undefined> => {
    signal.throwIfAborted();
    const envToken = env.CURSOR_ACCESS_TOKEN?.trim();
    if (envToken && !forceRefresh) return { accessToken: envToken, source: "CURSOR_ACCESS_TOKEN" };
    if (envToken && forceRefresh) throw new Error("CURSOR_ACCESS_TOKEN cannot be refreshed; replace it or /login cursor");
    if (!systemCredentialsAllowed(env.PI_CURSOR_SYSTEM_CREDENTIALS)) return undefined;
    const pairs = await abortable(Promise.all([(deps.keychain ?? keychain)(signal), (deps.ide ?? ide)(env, signal)]), signal);
    signal.throwIfAborted();
    if (!forceRefresh) for (let i = 0; i < pairs.length; i++) {
      const access = pairs[i]!.accessToken;
      if (access && now() < tokenExpiry(access, now())) return { accessToken: access, source: i ? "Cursor IDE (read-only)" : "Cursor CLI Keychain (read-only)" };
    }
    const seen = new Set<string>();
    for (const pair of pairs) {
      const refresh = pair.refreshToken;
      if (!refresh || seen.has(refresh)) continue;
      seen.add(refresh);
      const hash = createHash("sha256").update(refresh).digest("hex");
      if ((failures.get(hash) ?? 0) > now()) continue;
      try {
        const result = await oauth.refresh(refresh, signal);
        signal.throwIfAborted(); failures.delete(hash);
        return { accessToken: result.access, source: "Cursor system OAuth refresh (session only)" };
      } catch {
        signal.throwIfAborted(); failures.set(hash, now() + 600000);
      }
    }
    return undefined;
  };
}
export type SystemResolver = ReturnType<typeof createSystemResolver>;
