/** Direct OIDC publication. Registry reads reconcile writes; uploads are NEVER retried. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { releaseSource, verifyBundle } from "./release.mjs";
import { readNotice, sha256 } from "./package-licenses.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = "berialcheng/cursor-harness-provider";
const registry = "https://registry.npmjs.org/";
const workflowPath = ".github/workflows/publish.yml";
const kinds = ["native", "pi", "opencode"];
const predicateType = "https://slsa.dev/provenance/v1";
const reconciliationDelays = [0, 1000, 3000];
export const npmVersion = "11.21.0";
const stable = value => typeof value === "string" && value.length <= 128 &&
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) &&
  value.split(".").every(part => BigInt(part) <= BigInt(Number.MAX_SAFE_INTEGER));
const absolute = value => typeof value === "string" && isAbsolute(value) && !value.includes("\0");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const refused = () => ({ schemaVersion: 1, outcome: "refused", completion: false, freshPublication: false, packages: [] });
export class PublishReleaseError extends Error {
  constructor(message, audit = refused()) {
    super(message);
    this.name = "PublishReleaseError";
    this.audit = audit;
  }
}
class PublicConflict extends Error {}

function assertContext(env, version) {
  if (env.PUBLISH_NPM !== "true" || env.AUTOMATED_NPM_RELEASES !== "true") {
    throw new PublishReleaseError("Explicit PUBLISH_NPM=true and AUTOMATED_NPM_RELEASES=true are required");
  }
  const ref = "refs/tags/v" + version;
  // GITHUB_WORKFLOW_REF binds the executing workflow to this exact tag, and the
  // same-run source gate proves the workflow file belongs to the release
  // history. workflow_sha is deliberately not equality-checked: GitHub may
  // report the workflow file's last-modified commit rather than the run commit.
  if (!stable(version) || env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== ref ||
      env.GITHUB_WORKFLOW_REF !== repository + "/" + workflowPath + "@" + ref ||
      env.GITHUB_SERVER_URL !== "https://github.com") {
    throw new PublishReleaseError("Publication requires this repository's matching stable-tag publish.yml dispatch");
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || "") || !absolute(env.RUNNER_TEMP)) {
    throw new PublishReleaseError("A current GitHub commit/run/attempt and absolute runner temporary directory are required");
  }
  // Presence ONLY: npm owns the handshake. Do not inspect/copy/log OIDC values.
  if (!["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"].every(key => Object.hasOwn(env, key))) {
    throw new PublishReleaseError("GitHub OIDC endpoint environment is required");
  }
  // Reject even empty/case-varied overrides. Node injection/TLS overrides could
  // also defeat the isolated CLI/public reader; neither is needed by this job.
  if (Object.keys(env).some(key => /^(?:NPM_CONFIG_.*|NPM_.*TOKEN|NPM_AUTH|NODE_AUTH_TOKEN|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED)$/i.test(key))) {
    throw new PublishReleaseError("Legacy token/configuration environment overrides are forbidden");
  }
}

function officialURL(value) {
  if (typeof value !== "string" || value.length > 4096) throw new Error();
  const url = new URL(value);
  if (url.origin !== registry.slice(0, -1) || url.username || url.password || url.search || url.hash) throw new Error();
  return url;
}

/** Unauthenticated, bounded public reads; no redirects, npm config, or auth headers. */
async function readPublicJSON(value) {
  const url = officialURL(value);
  return new Promise((accept, reject) => {
    const request = get(url, { headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(15000) }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(Object.assign(new Error("Public registry lookup failed"), {
          code: response.statusCode === 404 ? "E404" : "EREGISTRY",
        }));
        return;
      }
      let length = 0;
      const chunks = [];
      response.on("data", chunk => {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) request.destroy(new Error("Public response too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try { accept(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("Invalid public registry JSON")); }
      });
    });
    request.on("error", reject);
  });
}

// Target is stable; a latest prerelease with the same core sorts below it.
// Anything malformed is UNKNOWN, never permission to move a dist-tag backward.
function latestAhead(value, target) {
  if (typeof value !== "string" || value.length > 256) throw new Error();
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match.slice(1, 4).some(part => BigInt(part) > BigInt(Number.MAX_SAFE_INTEGER)) ||
      match[4]?.split(".").some(part => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === "0")) throw new Error();
  const wanted = target.split(".");
  for (let i = 0; i < 3; i++) {
    if (BigInt(match[i + 1]) !== BigInt(wanted[i])) return BigInt(match[i + 1]) > BigInt(wanted[i]);
  }
  return false;
}

async function publicVersion(item, selector, readJSON) {
  let value;
  try { value = await readJSON(registry + item.name.replace("/", "%2f") + "/" + selector); }
  catch (error) {
    if (error?.code === "E404") return null;
    throw new Error("Unknown public version lookup");
  }
  if (!object(value) || value.name !== item.name || typeof value.version !== "string" ||
      (selector !== "latest" && value.version !== selector)) throw new Error("Invalid public version lookup");
  return value;
}

/** Parse npm's SLSA v1 DSSE source binding, NOT a cryptographic verification.
 * The post-publication job MUST independently verify signatures/transparency.
 * In particular, manifest.repository alone is never sufficient for reuse.
 */
async function publicSource(metadata, item, version, env, readJSON) {
  if (metadata.dist?.integrity !== item.integrity || metadata.dist?.shasum !== item.sha1) throw new PublicConflict();
  let url;
  try {
    url = officialURL(metadata.dist.attestations.url);
    const prefix = "/-/npm/v1/attestations/";
    if (!url.pathname.startsWith(prefix) || decodeURIComponent(url.pathname.slice(prefix.length)) !== item.name + "@" + version ||
        metadata.dist.attestations.provenance?.predicateType !== predicateType) throw new Error();
  } catch { throw new PublicConflict(); }
  const response = await readJSON(url.href);
  try {
    if (!Array.isArray(response?.attestations)) throw new Error();
    const entries = response.attestations.filter(entry => entry?.predicateType === predicateType);
    if (entries.length !== 1) throw new Error();
    const bundle = entries[0].bundle, envelope = bundle.dsseEnvelope;
    if (typeof bundle.mediaType !== "string" || !/^application\/vnd\.dev\.sigstore\.bundle(?:\+json;version=0\.[123]|\.v0\.3\+json)$/.test(bundle.mediaType) ||
        envelope.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string" ||
        envelope.payload.length > 2 * 1024 * 1024 || !Array.isArray(envelope.signatures) || !envelope.signatures.length ||
        envelope.signatures.some(signature => typeof signature.sig !== "string" || !signature.sig)) throw new Error();
    const bytes = Buffer.from(envelope.payload, "base64");
    if (bytes.toString("base64") !== envelope.payload) throw new Error();
    const statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const definition = statement.predicate.buildDefinition, workflow = definition.externalParameters.workflow;
    const dependencies = definition.resolvedDependencies;
    const details = statement.predicate.runDetails;
    if (typeof details.metadata.invocationId !== "string" || typeof details.builder?.id !== "string") throw new Error();
    const invocation = new RegExp("^https://github[.]com/" + repository + "/actions/runs/([1-9][0-9]*)/attempts/([1-9][0-9]*)$").exec(details.metadata.invocationId);
    if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== predicateType ||
        !Array.isArray(statement.subject) || statement.subject.length !== 1 ||
        statement.subject[0].name !== "pkg:npm/" + item.name.replace(/^@/, "%40") + "@" + version ||
        statement.subject[0].digest?.sha512 !== item.sha512 ||
        definition.buildType !== "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1" ||
        workflow.repository !== "https://github.com/" + repository || workflow.path !== workflowPath || workflow.ref !== env.GITHUB_REF ||
        definition.internalParameters?.github?.event_name !== "workflow_dispatch" ||
        !Array.isArray(dependencies) || dependencies.length !== 1 || dependencies[0].digest?.gitCommit !== env.GITHUB_SHA ||
        dependencies[0].uri !== "git+https://github.com/" + repository + "@" + env.GITHUB_REF ||
        details.builder.id !== "https://github.com/actions/runner/github-hosted" || !invocation) throw new Error();
    return { repository, workflow: workflowPath, ref: env.GITHUB_REF, commit: env.GITHUB_SHA,
      runId: invocation[1], runAttempt: invocation[2], cryptographicVerification: "required-post-publication" };
  } catch { throw new PublicConflict(); }
}

function reportAudit(audit, env) {
  // All values are fixed enums, validated identities or locally computed hashes.
  // No registry document, child output, exception details or environment dump.
  if (env.GITHUB_OUTPUT) {
    const values = { version: audit.version || "", outcome: audit.outcome, completion: audit.completion,
      fresh_publication: audit.freshPublication };
    if (audit.completion === true) {
      // Digit-only identities parsed by publicSource, never the current bundle's run.
      values.producers = JSON.stringify(Object.fromEntries(audit.packages.map(item => [item.kind,
        { runId: item.provenance.runId, runAttempt: item.provenance.runAttempt }])));
    }
    for (const item of audit.packages) for (const hash of ["sha256", "sha512", "sha1"]) {
      if (typeof item[hash] === "string") values[item.kind + "_" + hash] = item[hash];
    }
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => key + "=" + value + "\n").join(""));
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    "## npm direct publication\n\nSource bindings below are parsed, not a signature audit. Public cryptographic and isolated-install verification must follow.\n\n```json\n" +
    JSON.stringify(audit, null, 2) + "\n```\n");
}

/** execute may be sync/async; readJSON throws {code:'E404'} ONLY for an explicit
 * registry 404. wait is injectable; only reads, never writes, are retried.
 */
export async function publishRelease({ projectRoot = defaultRoot, bundleDirectory, version, npmCli, env = process.env },
  { verify = verifyBundle, source = releaseSource, execute = execFileSync, readJSON = readPublicJSON, wait = delay } = {}) {
  let audit = refused();
  try {
    assertContext(env, version);
    if (process.versions.node !== "22.22.0") throw new PublishReleaseError("Publication requires Node 22.22.0");
    if (!absolute(npmCli) || !absolute(bundleDirectory)) throw new PublishReleaseError("Explicit absolute bundle and npm CLI paths are required");
    let prepared, bundle;
    try { prepared = source(projectRoot); }
    catch { throw new PublishReleaseError("Release source validation failed; no publication attempted"); }
    if (prepared?.policy?.repository !== repository || prepared.version !== version ||
        kinds.some(kind => prepared.policy.packages?.[kind] !== "@cursor-harness-provider/" + kind) ||
        Object.keys(prepared.policy.packages).length !== 3) throw new PublishReleaseError("Requested version/repository/packages must match the source");
    try {
      // Current commit/run/attempt, BOTH lock hashes, platform coverage, archive
      // contents, licenses and actual packed-host evidence are bound here.
      bundle = verify({ projectRoot, bundleDirectory, localOnly: false });
    } catch { throw new PublishReleaseError("Release bundle verification failed; no publication attempted"); }
    if (bundle?.version !== version || bundle.identity?.localOnly !== false || bundle.identity.commit !== env.GITHUB_SHA ||
        bundle.identity.runId !== env.GITHUB_RUN_ID || bundle.identity.runAttempt !== env.GITHUB_RUN_ATTEMPT ||
        ![bundle.identity.npmLockSha256, bundle.identity.cargoLockSha256].every(hash => /^[a-f0-9]{64}$/.test(hash || "")) ||
        !Array.isArray(bundle.packages) || bundle.packages.length !== 3) throw new PublishReleaseError("Verified bundle must belong to the current release commit/run/attempt/locks");
    const packages = kinds.map(kind => {
      const items = bundle.packages.filter(item => item.kind === kind), item = items[0];
      if (items.length !== 1 || item.name !== prepared.policy.packages[kind] || item.file !== kind + ".tgz" ||
          !/^[a-f0-9]{64}$/.test(item.sha256)) throw new PublishReleaseError("Invalid verified package inventory");
      return { kind, name: item.name, file: kind + ".tgz", sha256: item.sha256, status: "not-attempted" };
    });
    audit = { ...audit, repository, version, bundleIdentity: {
      commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
      npmLockSha256: bundle.identity.npmLockSha256, cargoLockSha256: bundle.identity.cargoLockSha256,
    }, packages };
    const unchanged = () => {
      try {
        for (const item of packages) if (sha256(readNotice(bundleDirectory, item.file)) !== item.sha256) throw new Error();
      } catch { throw new PublishReleaseError("Bundle changed after verification; no further publication attempted", audit); }
    };
    unchanged();
    for (const item of packages) {
      const bytes = readNotice(bundleDirectory, item.file);
      if (sha256(bytes) !== item.sha256) throw new PublishReleaseError("Bundle changed after verification", audit);
      item.sha512 = createHash("sha512").update(bytes).digest("hex");
      item.sha1 = createHash("sha1").update(bytes).digest("hex");
      item.integrity = "sha512-" + Buffer.from(item.sha512, "hex").toString("base64");
    }
    const directory = mkdtempSync(join(env.RUNNER_TEMP, "publish-npm-config-"));
    const userConfig = join(directory, "user.npmrc"), globalConfig = join(directory, "global.npmrc");
    writeFileSync(userConfig, "", { flag: "wx", mode: 0o600 });
    writeFileSync(globalConfig, "", { flag: "wx", mode: 0o600 });
    const config = ["--userconfig", userConfig, "--globalconfig", globalConfig, "--registry", registry,
      "--fetch-retries", "0", "--cache", join(directory, "cache"), "--prefix", directory, "--no-update-notifier"];
    // Forward the environment ONLY to npm for OIDC, never to logs or public reads.
    const run = args => execute(process.execPath, [npmCli, ...args, ...config], {
      cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 1024 * 1024,
    });
    let actualVersion;
    try { actualVersion = (await run(["--version"])).trim(); }
    catch { throw new PublishReleaseError("Unable to verify the pinned npm CLI", audit); }
    if (actualVersion !== npmVersion) throw new PublishReleaseError("Publication requires npm 11.21.0", audit);
    const inspect = async item => {
      try {
        const exact = await publicVersion(item, version, readJSON), latest = await publicVersion(item, "latest", readJSON);
        const ahead = latest ? latestAhead(latest.version, version) : false;
        const provenance = exact ? await publicSource(exact, item, version, env, readJSON) : null;
        item.latest = latest?.version || null;
        return { exact, ahead, provenance };
      } catch (error) {
        item.status = error instanceof PublicConflict ? "conflict" : "lookup-unknown";
        throw new PublishReleaseError(error instanceof PublicConflict ?
          "Public version bytes/source conflict; no further publication attempted" :
          "Public version/latest lookup unknown; no further publication attempted", audit);
      }
    };
    const reuse = (item, provenance) => { item.status = "already-published"; item.provenance = provenance; };
    const superseded = () => { audit.outcome = "superseded"; return audit; };
    // Inspect ALL packages before the first upload, so a conflict/unknown in a
    // later adapter cannot cause a knowingly partial new release.
    const initial = [];
    for (const item of packages) {
      const state = await inspect(item); initial.push(state);
      if (state.exact) reuse(item, state.provenance);
    }
    if (initial.some(state => state.ahead)) superseded();
    else {
      for (const item of packages) {
        // Refresh immediately before each write, including concurrent exact
        // publication/latest changes since the all-package preflight. npm has
        // no tag compare-and-swap: publish.yml MUST serialize registry writers.
        const state = await inspect(item);
        if (state.ahead) { superseded(); break; }
        if (state.exact) { reuse(item, state.provenance); continue; }
        if (item.status === "already-published") throw new PublishReleaseError("Previously observed public version disappeared; stopped without upload", audit);
        unchanged(); // ALL archives, after every async read and before EVERY write.
        item.status = "uncertain";
        audit.outcome = "uncertain";
        let succeeded = false;
        try {
          await run(["publish", join(bundleDirectory, item.file), "--access", "public", "--tag", "latest", "--ignore-scripts", "--provenance"]);
          succeeded = true;
        } catch { /* A timeout/nonzero may follow acceptance. Never expose child output. */ }
        let accepted;
        for (const milliseconds of reconciliationDelays) {
          try {
            if (milliseconds) await wait(milliseconds);
            const exact = await publicVersion(item, version, readJSON);
            if (!exact) continue;
            const provenance = await publicSource(exact, item, version, env, readJSON);
            const latest = await publicVersion(item, "latest", readJSON);
            const ahead = latest ? latestAhead(latest.version, version) : false;
            item.latest = latest?.version || null;
            accepted = { provenance, ahead }; break;
          } catch (error) { if (error instanceof PublicConflict) break; }
        }
        if (!accepted) throw new PublishReleaseError("Publication outcome uncertain; bounded reconciliation could not prove acceptance. Stopped without upload retry or following packages", audit);
        item.provenance = accepted.provenance;
        // Prior-run bytes are valid immutable reuse, NOT a claimed same-run build.
        if (accepted.provenance.runId === env.GITHUB_RUN_ID && accepted.provenance.runAttempt === env.GITHUB_RUN_ATTEMPT) {
          item.status = succeeded ? "published" : "accepted-after-error";
          audit.freshPublication = true;
        } else reuse(item, accepted.provenance);
        if (accepted.ahead) { superseded(); break; }
      }
      if (audit.outcome !== "superseded") {
        unchanged();
        audit.outcome = audit.freshPublication ? "published" : "complete";
        audit.completion = true;
      }
    }
  } catch (error) {
    const safe = error instanceof PublishReleaseError ? error : new PublishReleaseError("Publication refused; no further actions attempted", audit);
    try { reportAudit(safe.audit, env); } catch { /* Preserve the original sanitized failure/audit. */ }
    throw safe;
  }
  try { reportAudit(audit, env); }
  catch { throw new PublishReleaseError("Unable to write sanitized publication audit", audit); }
  return audit;
}

export function parsePublishArgs(args) {
  const options = {}, keys = { "--bundle": "bundleDirectory", "--version": "version", "--npm-cli": "npmCli" };
  for (let i = 0; i < args.length; i += 2) {
    if (!Object.hasOwn(keys, args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || Object.hasOwn(options, keys[args[i]])) {
      throw new PublishReleaseError("Only --bundle, --version and --npm-cli are accepted, exactly once each");
    }
    options[keys[args[i]]] = args[i + 1];
  }
  if (!absolute(options.bundleDirectory) || !absolute(options.npmCli) || !stable(options.version) || Object.keys(options).length !== 3) {
    throw new PublishReleaseError("Absolute bundle/npm CLI paths and a stable release version are required");
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let audit, invoked = false;
  try {
    const options = parsePublishArgs(process.argv.slice(2));
    invoked = true;
    audit = await publishRelease(options);
  }
  catch (error) {
    audit = error instanceof PublishReleaseError ? error.audit : refused();
    if (!invoked) {
      try { reportAudit(audit, process.env); } catch { /* Still fail without leaking filesystem errors. */ }
    }
    console.error(error instanceof PublishReleaseError ? error.message : "Publication refused; no further actions attempted");
    process.exitCode = 1;
  }
  console.log(JSON.stringify(audit, null, 2));
}
