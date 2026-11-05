/** The only registry-writing path: OIDC staging, never final publication or approval. */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseSource, verifyBundle } from "./release.mjs";
import { readNotice, sha256 } from "./package-licenses.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = "berialcheng/cursor-harness-provider";
const kinds = ["native", "pi", "opencode"];
export const npmVersion = "11.21.0";
const refused = () => ({ schemaVersion: 1, outcome: "refused", packages: [] });
export class StageReleaseError extends Error {
  constructor(message, audit = refused()) {
    super(message);
    this.name = "StageReleaseError";
    this.audit = audit;
  }
}

function assertContext(env) {
  if (env.STAGE_NPM !== "true") throw new StageReleaseError("Explicit stage_npm=true is required");
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_REPOSITORY !== repository ||
      env.GITHUB_WORKFLOW_REF !== repository + "/.github/workflows/publish.yml@refs/heads/main") {
    throw new StageReleaseError("Staging requires this repository's main-branch publish.yml dispatch in GitHub Actions");
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || "") || !isAbsolute(env.RUNNER_TEMP || "")) {
    throw new StageReleaseError("A current GitHub commit/run/attempt and runner temporary directory are required");
  }
  // Presence checks ONLY. npm owns OIDC; never inspect or log endpoint/token values.
  if (!["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"].every(key => Object.hasOwn(env, key))) {
    throw new StageReleaseError("GitHub OIDC endpoint environment is required");
  }
  // Reject even empty/case-varied legacy configuration. CLI flags below control
  // config files, retries and the registry; provenance stays at npm's OIDC default.
  if (Object.keys(env).some(key => /^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_.*)$/i.test(key))) {
    throw new StageReleaseError("Legacy npm token/configuration environment overrides are forbidden");
  }
}

/** Injectable subprocess/verifier boundaries let tests exercise every gate without uploads. */
export function stageRelease({ projectRoot = defaultRoot, bundleDirectory, version, npmCli, env = process.env },
  { verify = verifyBundle, source = releaseSource, execute = execFileSync } = {}) {
  assertContext(env);
  if (process.versions.node !== "22.22.0") throw new StageReleaseError("Staging requires Node 22.22.0");
  if (typeof npmCli !== "string" || !isAbsolute(npmCli) || typeof bundleDirectory !== "string" || !isAbsolute(bundleDirectory)) {
    throw new StageReleaseError("Explicit absolute bundle and npm CLI paths are required");
  }
  let prepared;
  try { prepared = source(projectRoot); }
  catch { throw new StageReleaseError("Release source validation failed; nothing was staged"); }
  if (prepared.policy.repository !== repository || prepared.version !== version || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version) ||
      kinds.some(kind => prepared.policy.packages[kind] !== "@cursor-harness-provider/" + kind)) {
    throw new StageReleaseError("Requested release version/repository/packages must match the source");
  }
  let bundle;
  try {
    // Verifies source SHA, run/attempt, both lock hashes, coverage, licenses and
    // every archive's contents/checksum before ANY package can be uploaded.
    bundle = verify({ projectRoot, bundleDirectory, localOnly: false });
  } catch { throw new StageReleaseError("Release bundle verification failed; nothing was staged"); }
  if (bundle.version !== version || bundle.identity?.localOnly !== false || bundle.identity.commit !== env.GITHUB_SHA ||
      bundle.identity.runId !== env.GITHUB_RUN_ID || bundle.identity.runAttempt !== env.GITHUB_RUN_ATTEMPT ||
      !Array.isArray(bundle.packages) || bundle.packages.length !== kinds.length) {
    throw new StageReleaseError("Verified bundle must belong to the current release commit/run/attempt");
  }
  const packages = kinds.map(kind => {
    const items = bundle.packages.filter(item => item.kind === kind);
    if (items.length !== 1 || items[0].name !== prepared.policy.packages[kind] || items[0].file !== kind + ".tgz" ||
        !/^[a-f0-9]{64}$/.test(items[0].sha256)) throw new StageReleaseError("Invalid verified package inventory");
    // Never forward raw npm output, arbitrary manifest fields or environment data.
    return { kind, name: items[0].name, file: kind + ".tgz", sha256: items[0].sha256, status: "not-attempted" };
  });
  const audit = { schemaVersion: 1, outcome: "refused", repository, version, commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, packages };
  const config = ["--userconfig", "/dev/null", "--globalconfig", "/dev/null", "--fetch-retries", "0",
    "--cache", join(env.RUNNER_TEMP, "stage-npm-cache"), "--no-update-notifier"];
  const run = args => execute(process.execPath, [npmCli, ...args], {
    cwd: bundleDirectory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000, maxBuffer: 1024 * 1024,
  });
  // Pass env unchanged for npm's OIDC handshake; do not copy/read OIDC values.
  let actualVersion;
  try { actualVersion = run(["--version", ...config]).trim(); }
  catch { throw new StageReleaseError("Unable to verify the pinned npm CLI; nothing was staged", audit); }
  if (actualVersion !== npmVersion) throw new StageReleaseError("Staging requires npm 11.21.0", audit);
  for (const item of packages) {
    // Recheck ALL archives before each write, including after the CLI version
    // check. Never knowingly upload a bundle that changed after verification.
    try {
      for (const archive of packages) if (sha256(readNotice(bundleDirectory, archive.file)) !== archive.sha256) throw new Error();
    } catch { throw new StageReleaseError("Bundle changed after verification; no further staging attempted", audit); }
    item.status = "uncertain";
    audit.outcome = "uncertain";
    try {
      run(["stage", "publish", join(bundleDirectory, item.file), "--access", "public",
        "--registry", "https://registry.npmjs.org/", "--ignore-scripts", ...config]);
    } catch {
      // A timeout/nonzero exit may follow an accepted upload. No retries, no
      // following packages, and no raw child output/error (which may be sensitive).
      throw new StageReleaseError("Staging outcome uncertain; stopped without retry. Reconcile manually in npm before any new dispatch", audit);
    }
    item.status = "staged-pending-human-approval";
  }
  audit.outcome = "pending-human-approval";
  return audit;
}

export function parseStageArgs(args) {
  const options = {}, keys = { "--bundle": "bundleDirectory", "--version": "version", "--npm-cli": "npmCli" };
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]];
    if (!Object.hasOwn(keys, args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || Object.hasOwn(options, key)) {
      throw new StageReleaseError("Only --bundle, --version and --npm-cli are accepted, exactly once each");
    }
    options[key] = args[i + 1];
  }
  if (Object.keys(options).length !== 3) throw new StageReleaseError("All staging arguments are required");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let audit;
  try { audit = stageRelease(parseStageArgs(process.argv.slice(2))); }
  catch (error) {
    audit = error instanceof StageReleaseError ? error.audit : refused();
    console.error(error instanceof StageReleaseError ? error.message : "Staging refused; no further actions attempted");
    process.exitCode = 1;
  }
  const result = JSON.stringify(audit, null, 2);
  console.log(result);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, "## npm staging (not final publication)\n\n" +
        "Human npm approval/2FA is required outside CI. Never blindly retry an uncertain upload.\n\n```json\n" + result + "\n```\n");
    } catch { console.error("Unable to write sanitized stage summary"); process.exitCode = 1; }
  }
}
