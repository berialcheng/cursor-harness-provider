// Isolated peer-host fixture. Run with CURSOR_PI_COMPAT_HOST_ROOT pointing to an
// already-installed pi-coding-agent package; never installs or changes that host.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
const host = process.env.CURSOR_PI_COMPAT_HOST_ROOT;
if (!host) throw new Error("Set CURSOR_PI_COMPAT_HOST_ROOT to an existing pi-coding-agent package directory");
const require = createRequire(join(host, "package.json"));
const aiRoot = require.resolve.paths("@earendil-works/pi-ai")?.map(path => join(path, "@earendil-works/pi-ai"))
  .find(path => existsSync(join(path, "dist/compat.js")));
if (!aiRoot) throw new Error("Host pi-ai peer unavailable");
export default defineConfig({
  resolve: { alias: [
    { find: /^@earendil-works\/pi-ai\/compat$/, replacement: join(aiRoot, "dist/compat.js") },
    { find: /^@earendil-works\/pi-ai$/, replacement: join(aiRoot, "dist/index.js") },
    { find: /^@earendil-works\/pi-coding-agent$/, replacement: join(host, "dist/index.js") },
  ] },
  test: { include: ["test/pi/compat.test.ts", "test/pi/compat-provenance.test.ts", "test/pi/compat-loader.test.ts", "test/pi/session-lifecycle.test.ts", "test/pi/recovery-commands.test.ts", "test/pi/auth-deadline.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 10000, maxWorkers: 1 },
});
