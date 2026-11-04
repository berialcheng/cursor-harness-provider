import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, vi } from "vitest";
import { shutdownRustEngines } from "@cursor-native/native";

// Per-worker fixtures only: never consult the user's Cursor config, credentials,
// caches, proxy, or a live endpoint. beforeEach reapplies this after tests that
// explicitly restore their own environment stubs.
const cache = realpathSync(mkdtempSync(join(tmpdir(), "cursor-native-tests-")));
function isolate() {
  for (const [name, value] of Object.entries({
    OPENCODE_CURSOR_CACHE_DIR: cache,
    CURSOR_NATIVE_CACHE_DIR: cache,
    PI_CURSOR_CACHE_DIR: cache,
    CURSOR_CONFIG_DIR: join(cache, "cursor-config"),
    OPENCODE_CURSOR_AGENT_URL: "http://127.0.0.1:9",
    CURSOR_AGENT_URL: "http://127.0.0.1:9",
    PI_CURSOR_AGENT_URL: "http://127.0.0.1:9",
    OPENCODE_CURSOR_OFFLINE: "1",
    OPENCODE_CURSOR_PROVIDER_DEBUG: "0",
    PI_CURSOR_PROVIDER_DEBUG: "0",
    CURSOR_DEBUG: "0",
    NO_PROXY: "*",
    no_proxy: "*",
  })) vi.stubEnv(name, value);
  for (const name of ["CURSOR_ACCESS_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, undefined);
}
isolate();
beforeEach(isolate);
afterAll(() => {
  try { shutdownRustEngines(); }
  finally { vi.unstubAllEnvs(); rmSync(cache, { recursive: true, force: true }); }
});
