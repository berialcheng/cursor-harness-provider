/** Read-only CLI/IDE credential reuse, ported from pi-cursor 1.4.39 (MIT,
 * Rahul Arya). Never invoked at import/extension-factory time. No CLI inference.
 * See ../../THIRD_PARTY_NOTICES.md. Tests inject both readers. */
import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
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
  return { accessToken: await read("cursor-access-token") };
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
        pair = { accessToken: read("accessToken") };
      } finally { db.close(); }
      if (pair.accessToken && tokenExpiry(pair.accessToken) > Date.now()) return pair;
    } catch { /* absent/locked profile */ }
  }
  return {};
}
export function createSystemResolver(_oauth: OAuthClient, deps: SystemDependencies = {}) {
  const now = deps.now ?? Date.now;
  // Keep the resolver signature compatible, but all reuse is access-only. The external
  // CLI/IDE owns its refresh pair and must renew it itself; Pi cannot persist its rotation.
  return async (env: NodeJS.ProcessEnv, signal: AbortSignal, forceRefresh = false, _accessOnly = true): Promise<SystemToken | undefined> => {
    signal.throwIfAborted();
    const envToken = env.CURSOR_ACCESS_TOKEN?.trim();
    if (envToken && !forceRefresh) return { accessToken: envToken, source: "CURSOR_ACCESS_TOKEN" };
    if (envToken && forceRefresh) throw new Error("CURSOR_ACCESS_TOKEN cannot be refreshed; replace it or /login cursor");
    if (!systemCredentialsAllowed(env.PI_CURSOR_SYSTEM_CREDENTIALS)) return undefined;
    const pairs = await abortable(Promise.all([(deps.keychain ?? keychain)(signal), (deps.ide ?? ide)(env, signal)]), signal);
    signal.throwIfAborted();
    for (let i = 0; i < pairs.length; i++) {
      const access = pairs[i]!.accessToken;
      if (access && now() < tokenExpiry(access, now())) return { accessToken: access, source: i ? "Cursor IDE (read-only)" : "Cursor CLI Keychain (read-only)" };
    }
    return undefined;
  };
}
export type SystemResolver = ReturnType<typeof createSystemResolver>;
