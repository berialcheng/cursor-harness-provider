/** One-time package placeholders only. Real 0.3.0 artifacts use the OIDC stage job. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const registry = "https://registry.npmjs.org/";
const names = ["native", "pi", "opencode"].map(kind => "@cursor-harness-provider/" + kind);
export function bootstrapPackages({ npmCli, sessionConfig, directory, projectRoot = root, env = process.env }, execute = execFileSync) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_REPOSITORY !== "berialcheng/cursor-harness-provider" ||
      env.GITHUB_WORKFLOW_REF !== "berialcheng/cursor-harness-provider/.github/workflows/npm-bootstrap.yml@refs/heads/main" ||
      env.BOOTSTRAP_NPM !== "create-three-public-package-placeholders") throw new Error("Explicit main-branch bootstrap dispatch required");
  if (![npmCli, sessionConfig, directory, env.RUNNER_TEMP].every(path => typeof path === "string" && isAbsolute(path))) throw new Error("Absolute runner paths required");
  for (const path of [sessionConfig, directory, npmCli]) {
    const rel = relative(env.RUNNER_TEMP, path);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Bootstrap paths must stay in runner temporary storage");
  }
  if (Object.keys(env).some(key => /^(?:NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(key))) throw new Error("No token environment credentials allowed");
  const config = ["--userconfig", sessionConfig, "--globalconfig", "/dev/null", "--registry", registry,
    "--fetch-retries", "0", "--cache", join(env.RUNNER_TEMP, "npm-bootstrap-cache"), "--no-update-notifier"];
  const run = args => execute(process.execPath, [npmCli, ...args, ...config], {
    cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90000, maxBuffer: 1024 * 1024,
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let version, owner;
  try { version = run(["--version"]).trim(); owner = run(["whoami"]).trim(); }
  catch { throw new Error("Interactive owner verification failed; no packages staged"); }
  if (version !== "11.21.0" || owner !== "berialcheng") throw new Error("Pinned npm CLI and expected interactive owner required");
  const result = [];
  for (const name of names) {
    let exists = false;
    try {
      if (JSON.parse(run(["view", name, "name", "--json"])) !== name) throw new Error("Unexpected package identity");
      exists = true;
    }
    catch (error) {
      let code;
      try { code = JSON.parse(String(error.stdout || error.stderr)).error?.code; } catch { /* Do not expose child output. */ }
      if (code !== "E404") throw new Error("Unable to establish package absence; bootstrap stopped");
    }
    if (exists) { result.push({ name, status: "already-exists-not-modified" }); continue; }
    const base = join(directory, name.split("/")[1]); mkdirSync(base, { mode: 0o700 });
    writeFileSync(join(base, "package.json"), JSON.stringify({ name, version: "0.0.0-bootstrap", private: false,
      description: "Unapproved Trusted Publisher setup candidate; never approve this version", license: "MIT",
      repository: { type: "git", url: "git+https://github.com/berialcheng/cursor-harness-provider.git" },
      publishConfig: { registry, access: "public" } }, null, 2) + "\n", { flag: "wx" });
    writeFileSync(join(base, "README.md"), "# Setup candidate — do not approve\n\nThis metadata-only candidate creates npm's public 0.0.0-stage placeholder so that the owner can configure Trusted Publishing. Reject this 0.0.0-bootstrap candidate. The real 0.3.0 artifacts are staged separately by the verified OIDC workflow.\n", { flag: "wx" });
    copyFileSync(join(projectRoot, "LICENSE"), join(base, "LICENSE"));
    try { run(["stage", "publish", base, "--access", "public", "--tag", "bootstrap", "--ignore-scripts", "--provenance=false"]); }
    catch { throw new Error("Bootstrap upload outcome uncertain; inspect npm before retrying. No further packages attempted"); }
    result.push({ name, status: "placeholder-created-bootstrap-candidate-must-be-rejected" });
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [npmCli, sessionConfig, directory] = process.argv.slice(2);
    console.log(JSON.stringify(bootstrapPackages({ npmCli, sessionConfig, directory }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
