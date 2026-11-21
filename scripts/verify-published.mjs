/** Read-only public-registry verification. Never publishes or provisions a host/CLI. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

export const npmVersion = "11.21.0";
const repository = "berialcheng/cursor-harness-provider";
const repositoryUrl = "https://github.com/" + repository;
const registry = "https://registry.npmjs.org/";
const attestationPath = "/-/npm/v1/attestations/";
const kinds = ["native", "pi", "opencode"];
const nameFor = kind => "@cursor-harness-provider/" + kind;
const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const jsonLimit = 4 * 1024 * 1024, archiveLimit = 128 * 1024 * 1024, fetchTimeout = 60000;
const predicateType = "https://slsa.dev/provenance/v1";
const buildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const legacySource = "fb6089e011b40f89c65bf66a4afcb43791040919";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (value, keys) => record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const hash = (bytes, algorithm, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const utf8 = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const positive = value => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);

export class PublishedVerificationError extends Error {
  constructor(message) { super(message); this.name = "PublishedVerificationError"; }
}
function requireThat(condition, message) {
  if (!condition) throw new PublishedVerificationError(message);
}
function json(text, label) {
  requireThat(typeof text === "string" && Buffer.byteLength(text) <= jsonLimit, "Invalid/oversized " + label);
  try { return JSON.parse(text); }
  catch { throw new PublishedVerificationError("Invalid JSON in " + label); }
}
function expectedHashes(value) {
  if (typeof value === "string") {
    // Exactly three literal JSON members, including before JSON.parse discards
    // duplicate keys. Escaped/duplicate/extra keys are deliberately not accepted.
    const member = '"(?:native|pi|opencode)"\\s*:\\s*"[a-f0-9]{64}"';
    requireThat(value.length <= 1024 && new RegExp("^\\s*\\{\\s*" + member + "(?:\\s*,\\s*" + member + "){2}\\s*\\}\\s*$").test(value), "Exactly three native/pi/opencode SHA256 hashes are required");
    value = json(value, "expected hashes");
  }
  requireThat(sameKeys(value, kinds) && kinds.every(kind => typeof value[kind] === "string" && /^[a-f0-9]{64}$/.test(value[kind])),
    "Exactly three native/pi/opencode SHA256 hashes are required");
  return Object.fromEntries(kinds.map(kind => [kind, value[kind]]));
}
function expectedProducers(value) {
  if (value === undefined) return undefined;
  const message = "Exactly three native/pi/opencode producers with runId/runAttempt positive decimal strings are required";
  if (typeof value === "string") {
    // Bound and count literal members before JSON.parse can discard duplicate
    // package/selector keys. Escaped keys and numeric IDs are not accepted.
    const field = '"(?:runId|runAttempt)"\\s*:\\s*"[1-9][0-9]{0,19}"';
    const member = '"(?:native|pi|opencode)"\\s*:\\s*\\{\\s*' + field + "\\s*,\\s*" + field + "\\s*\\}";
    requireThat(value.length <= 1024 && new RegExp("^\\s*\\{\\s*" + member + "(?:\\s*,\\s*" + member + "){2}\\s*\\}\\s*$").test(value), message);
    value = json(value, "producers");
  }
  requireThat(sameKeys(value, kinds) && kinds.every(kind => sameKeys(value[kind], ["runId", "runAttempt"]) &&
    positive(value[kind].runId) && positive(value[kind].runAttempt)), message);
  return Object.fromEntries(kinds.map(kind => [kind, { runId: value[kind].runId, runAttempt: value[kind].runAttempt }]));
}
function sourceReference(version, source, expectedSourceRef) {
  const sourceRef = expectedSourceRef ?? "refs/tags/v" + version;
  // Programmatic legacy verification ONLY: the already-published 0.3.0 was
  // produced by publish.yml on main at this immutable commit. No CLI escape or
  // general branch/ref override is provided for new releases.
  requireThat(sourceRef === "refs/tags/v" + version ||
    (sourceRef === "refs/heads/main" && version === "0.3.0" && source === legacySource), "Provenance must use the matching immutable version tag");
  return sourceRef;
}
function selectors(options) {
  const { version, source, npmCli, outputDirectory, sourceRun, sourceAttempt } = options;
  requireThat(typeof version === "string" && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(version) &&
    version.length <= 64 && version.split(".").every(part => Number.isSafeInteger(Number(part))), "A canonical stable release version is required");
  requireThat(typeof source === "string" && /^[a-f0-9]{40}$/.test(source), "An exact lowercase source SHA40 is required");
  requireThat(typeof npmCli === "string" && isAbsolute(npmCli) && typeof outputDirectory === "string" && isAbsolute(outputDirectory),
    "Absolute npm CLI and fresh output directory paths are required");
  requireThat((sourceRun === undefined && sourceAttempt === undefined) || (positive(sourceRun) && positive(sourceAttempt)),
    "Source run and attempt must be positive decimal strings, supplied together");
  const producers = expectedProducers(options.producers);
  requireThat(producers === undefined || sourceRun === undefined || kinds.every(kind =>
    producers[kind].runId === sourceRun && producers[kind].runAttempt === sourceAttempt),
  "Common source run/attempt contradicts explicit package producers");
  const sourceRef = sourceReference(version, source, options.expectedSourceRef);
  const allowPartial = options.allowPartial === undefined ? false : options.allowPartial;
  requireThat(typeof allowPartial === "boolean", "allowPartial must be a boolean");
  return { version, source, npmCli, outputDirectory, sourceRun, sourceAttempt, sourceRef, producers, allowPartial, expectedSha256: expectedHashes(options.expectedSha256) };
}
function registryUrl(value, attestations = false) {
  requireThat(typeof value === "string" && value.length <= 2048 && !/[\s\\\x00-\x1f\x7f]/.test(value), "Invalid public registry URL");
  let url, decoded;
  try { url = new URL(value); decoded = decodeURIComponent(url.pathname); }
  catch { throw new PublishedVerificationError("Invalid public registry URL"); }
  requireThat(url.origin === registry.slice(0, -1) && !url.username && !url.password && !url.search && !url.hash && url.href === value,
    "Only canonical credential-free official registry URLs are allowed");
  requireThat(!/[\s\\\x00-\x1f\x7f]/.test(decoded) && !decoded.split("/").some(part => part === "." || part === ".."), "Invalid registry path");
  if (attestations) requireThat(url.pathname.startsWith(attestationPath) &&
    /^[A-Za-z0-9@._/-]+$/.test(decoded.slice(attestationPath.length)) && !decoded.slice(attestationPath.length).split("/").includes(""),
  "Only the public registry attestation endpoint is allowed");
  return url.href;
}

/** Bounded credential-free GET; the injectable fetch must honor the supplied signal. */
export async function fetchRegistryJson(url, { fetch: request = globalThis.fetch } = {}) {
  registryUrl(url, true);
  let response, reader;
  try {
    response = await request(url, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(fetchTimeout) });
    requireThat(response.status === 200 && !response.redirected && (!response.url || response.url === url), "Attestation GET failed or redirected");
    requireThat(/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || ""), "Attestation response must be JSON");
    const length = response.headers.get("content-length");
    requireThat(length === null || (/^(?:0|[1-9][0-9]*)$/.test(length) && Number(length) <= jsonLimit), "Oversized attestation response");
    requireThat(response.body, "Missing attestation response body");
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireThat(size <= jsonLimit, "Oversized attestation response");
      chunks.push(Buffer.from(value));
    }
    return json(utf8(Buffer.concat(chunks, size)), "attestation response");
  } catch (error) {
    if (error instanceof PublishedVerificationError) throw error;
    throw new PublishedVerificationError("Public attestation GET failed; stopped without retry");
  } finally {
    // Cancel even when status/headers reject a body before its first read.
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else if (response?.body) await response.body.cancel().catch(() => {});
  }
}

function readBounded(path, limit) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    requireThat(before.isFile() && before.nlink === 1 && before.size <= limit, "Non-regular/linked/oversized verification input");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      requireThat(count > 0, "Verification input changed while reading"); offset += count;
    }
    const extra = readSync(fd, Buffer.alloc(1), 0, 1, null), after = fstatSync(fd);
    requireThat(extra === 0 && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
      "Verification input changed while reading");
    return bytes;
  } finally { if (fd !== undefined) closeSync(fd); }
}
const readJson = path => json(utf8(readBounded(path, jsonLimit)), "verification file");
function dependencies(pkg, kind, version) {
  const wanted = kind === "native" ? [] : [nameFor("native")];
  requireThat(sameKeys(pkg.dependencies === undefined ? {} : pkg.dependencies, wanted) &&
    (kind === "native" || pkg.dependencies[nameFor("native")] === version), "Unexpected package dependencies");
  requireThat(sameKeys(pkg.optionalDependencies === undefined ? {} : pkg.optionalDependencies, []), "Optional dependencies are forbidden");
}
function packageIdentity(pkg, kind, version) {
  requireThat(record(pkg) && pkg.name === nameFor(kind) && pkg.version === version && pkg.license === "MIT", "Package name/version/MIT identity mismatch");
  dependencies(pkg, kind, version);
}
function checkSource(projectRoot, version) {
  const root = readJson(join(projectRoot, "package.json"));
  requireThat(root.name === "cursor-harness-provider" && root.version === version && root.private === true && root.license === "MIT", "Source root identity/version mismatch");
  for (const kind of kinds) {
    const pkg = readJson(join(projectRoot, "packages", kind, "package.json"));
    packageIdentity(pkg, kind, version);
    requireThat(pkg.private === false && pkg.repository?.url === "git+" + repositoryUrl + ".git" && pkg.repository?.directory === "packages/" + kind &&
      pkg.publishConfig?.registry === registry && pkg.publishConfig?.access === "public", "Unexpected source package repository/publication identity");
  }
}
function archiveDigests(path) {
  const bytes = readBounded(path, archiveLimit);
  requireThat(bytes.length > 0, "Empty published archive");
  return { sha256: hash(bytes, "sha256"), shasum: hash(bytes, "sha1"), sha512: hash(bytes, "sha512"), integrity: "sha512-" + hash(bytes, "sha512", "base64") };
}
function checkDigests(digests, expected, dist) {
  requireThat(digests.sha256 === expected, "Published archive SHA256 differs from protected release input");
  requireThat(digests.shasum === dist.shasum && digests.integrity === dist.integrity, "Published archive SHA1/SRI differs from public metadata");
}
function base64(value) {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= jsonLimit && value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), "Invalid DSSE base64");
  const bytes = Buffer.from(value, "base64");
  requireThat(bytes.toString("base64") === value, "Non-canonical DSSE base64");
  return bytes;
}

function attestationContents(document) {
  requireThat(record(document) && Array.isArray(document.attestations) && document.attestations.length > 0 && document.attestations.length <= 16 &&
    document.attestations.every(item => record(item) && typeof item.predicateType === "string" && record(item.bundle)), "Invalid npm attestation bundle schema");
  return document.attestations.map(item => {
    const envelope = item.bundle.dsseEnvelope;
    requireThat(record(envelope) && envelope.payloadType === "application/vnd.in-toto+json" && Array.isArray(envelope.signatures) &&
      envelope.signatures.length > 0 && envelope.signatures.length <= 16, "Invalid DSSE envelope");
    for (const signature of envelope.signatures) requireThat(record(signature) && base64(signature.sig).length > 0 &&
      (signature.keyid === undefined || typeof signature.keyid === "string"), "Invalid DSSE signature");
    return { predicateType: item.predicateType, payloadType: envelope.payloadType, payload: envelope.payload,
      statement: json(utf8(base64(envelope.payload)), "DSSE statement") };
  });
}
const payloadBinding = document => JSON.stringify(attestationContents(document)
  .map(({ predicateType, payloadType, payload }) => JSON.stringify([predicateType, payloadType, payload])).sort());

/** Content checks must also run on npm's cryptographically verified bundles. */
export function verifyProvenance(document, { kind, version, source, sourceRef = "refs/tags/v" + version, sha512, sourceRun, sourceAttempt }) {
  sourceReference(version, source, sourceRef);
  const candidates = attestationContents(document).filter(item => item.predicateType === predicateType);
  requireThat(candidates.length === 1, "Exactly one SLSA v1 provenance attestation is required");
  const statement = candidates[0].statement;
  requireThat(record(statement) && statement._type === "https://in-toto.io/Statement/v1" && statement.predicateType === predicateType &&
    Array.isArray(statement.subject) && statement.subject.length === 1, "Invalid SLSA v1 statement");
  const subject = statement.subject[0];
  requireThat(record(subject) && subject.name === "pkg:npm/%40cursor-harness-provider/" + kind + "@" + version &&
    record(subject.digest) && typeof sha512 === "string" && /^[a-f0-9]{128}$/.test(sha512) && subject.digest.sha512 === sha512,
  "Provenance subject name/version/SHA512 mismatch");
  const definition = statement.predicate?.buildDefinition, workflow = definition?.externalParameters?.workflow;
  requireThat(definition?.buildType === buildType && workflow?.repository === repositoryUrl && workflow?.path === ".github/workflows/publish.yml" &&
    workflow?.ref === sourceRef, "Provenance repository/publish.yml/version ref mismatch");
  const inputs = definition.resolvedDependencies;
  requireThat(Array.isArray(inputs) && inputs.length === 1 && inputs[0]?.uri === "git+" + repositoryUrl + "@" + sourceRef &&
    inputs[0]?.digest?.gitCommit === source, "Provenance source gitCommit/ref mismatch");
  const runDetails = statement.predicate?.runDetails;
  requireThat(runDetails?.builder?.id === "https://github.com/actions/runner/github-hosted", "Provenance builder must be GitHub-hosted");
  const invocation = runDetails.metadata?.invocationId;
  const prefix = repositoryUrl + "/actions/runs/";
  const match = typeof invocation === "string" && invocation.startsWith(prefix) && /^([1-9][0-9]{0,19})\/attempts\/([1-9][0-9]{0,19})$/.exec(invocation.slice(prefix.length));
  requireThat(match, "Invalid provenance producer run/attempt");
  requireThat((sourceRun === undefined && sourceAttempt === undefined) ||
    (match[1] === sourceRun && match[2] === sourceAttempt), "Provenance producer run/attempt mismatch");
  return { runId: match[1], runAttempt: match[2] };
}

export function verifySignatureAudit(stdout, expectedCount = 3) {
  requireThat(Number.isInteger(expectedCount) && expectedCount >= 1 && expectedCount <= 3, "Signature audit requires 1, 2 or 3 expected packages");
  requireThat(typeof stdout === "string" && Buffer.byteLength(stdout) <= jsonLimit, "Invalid signature audit output");
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const plural = expectedCount === 1 ? "" : "s", have = expectedCount === 1 ? " package has a verified " : " packages have verified ";
  requireThat((lines.length === 3 || (lines.length === 4 && lines[3] === "(use --json --include-attestations to view attestation details)")) &&
    new RegExp("^audited " + expectedCount + " package" + plural + " in [0-9]+s$").test(lines[0]) &&
    lines[1] === expectedCount + have + "registry signature" + plural && lines[2] === expectedCount + have + "attestation" + plural,
  "npm must verify exactly " + expectedCount + " registry signatures and " + expectedCount + " attestations (no zero/partial audit); observed " + JSON.stringify(lines));
  return { registrySignatures: expectedCount, attestations: expectedCount };
}
function producerSelectors(request, kind) {
  const expected = request.producers?.[kind];
  return { sourceRun: expected?.runId ?? request.sourceRun, sourceAttempt: expected?.runAttempt ?? request.sourceAttempt };
}
function verifyAttestationAudit(stdout, receipts, request, preflightBindings) {
  const audit = json(stdout, "verified attestation audit");
  // Sanitized diagnostics: npm-fixed schema key names and counts only.
  const shape = { keys: Object.keys(audit).sort(), invalid: audit.invalid?.length, missing: audit.missing?.length, verified: audit.verified?.length, verifiedNames: Array.isArray(audit.verified) ? audit.verified.map(row => row?.name).sort() : undefined, receipts: receipts.length };
  requireThat(sameKeys(audit, ["invalid", "missing", "verified"]) && Array.isArray(audit.invalid) && audit.invalid.length === 0 &&
    Array.isArray(audit.missing) && audit.missing.length === 0 && Array.isArray(audit.verified) && receipts.length > 0 &&
    audit.verified.length === receipts.length, "npm JSON must contain exactly the expected nonzero verified packages and no invalid/missing entries; observed shape " + JSON.stringify(shape));
  const seen = new Set();
  for (const row of audit.verified) {
    requireThat(sameKeys(row, ["name", "version", "location", "registry", "attestations", "attestationBundles"]), "Invalid npm verified package row");
    const receipt = receipts.find(item => item.name === row.name);
    requireThat(receipt && !seen.has(row.name) && row.version === request.version && row.location === "node_modules/" + row.name &&
      row.registry === registry, "Unexpected/duplicate npm verified package identity/version/location/registry");
    seen.add(row.name);
    requireThat(record(row.attestations) && registryUrl(row.attestations.url, true) === receipt.attestations,
      "Verified attestation metadata differs from public package endpoint");
    // npm 11.21.0 returns only rows whose EVERY bundle passed pacote's
    // sigstore.verify and package-subject/integrity checks. Inspect these exact
    // signed payloads, not the separately fetched, untrusted preflight alone.
    const document = { attestations: row.attestationBundles };
    const producer = verifyProvenance(document, { ...request, kind: receipt.kind, sha512: receipt.sha512, ...producerSelectors(request, receipt.kind) });
    requireThat(payloadBinding(document) === preflightBindings.get(receipt.kind), "Attestation payloads changed between preflight and cryptographic audit");
    Object.assign(receipt, { producer, location: row.location, registry: row.registry, attestationBundles: row.attestationBundles });
  }
}
function explicitView404(error) {
  // execFileSync reports npm's structured --json error on stdout. Do not infer
  // absence from stderr prose, ETARGET, permissions, a signal or transport errors.
  try {
    if (error?.status !== 1 || (error.signal !== null && error.signal !== undefined) || error.code !== undefined || error.killed === true) return false;
    const stdout = error.stdout;
    if (Buffer.isBuffer(stdout) && stdout.length > jsonLimit) return false;
    const value = json(Buffer.isBuffer(stdout) ? utf8(stdout) : stdout, "npm view error");
    return record(value) && record(value.error) && value.error.code === "E404";
  } catch { return false; }
}
function checkLock(audit, receipts, version) {
  const bytes = readBounded(join(audit, "package-lock.json"), jsonLimit), lock = json(utf8(bytes), "installed lockfile");
  const names = receipts.map(item => item.name), entries = ["", ...names.map(name => "node_modules/" + name)];
  requireThat(record(lock) && lock.lockfileVersion === 3 && sameKeys(lock.packages, entries) &&
    sameKeys(lock.packages[""]?.dependencies, names) && names.every(name => lock.packages[""].dependencies[name] === version),
  "Isolated install must contain exactly " + receipts.length + " exact-version registry lock entries");
  for (const receipt of receipts) {
    const pkg = lock.packages["node_modules/" + receipt.name];
    requireThat(record(pkg) && pkg.version === version && pkg.integrity === receipt.integrity && !pkg.link && !pkg.optional &&
      registryUrl(pkg.resolved) === receipt.tarball, "Installed lock integrity/version/resolved registry mismatch");
    dependencies(pkg, receipt.kind, version);
    packageIdentity(readJson(join(audit, "node_modules", receipt.name, "package.json")), receipt.kind, version);
  }
  return bytes;
}

/**
 * execute has execFileSync's signature; fetchJson(url) returns parsed bounded JSON.
 * Supply both in tests: synthetic DSSE is NOT cryptographic verification. The
 * production path pins npm and requires its real, nonzero JSON bundle audit
 * plus text signature counts. allowPartial defaults false; only an explicit
 * npm view E404 can be reconciled as missing. No install/audit runs if all are
 * absent. outputDirectory must not exist; archives/ remain for test:packages.
 */
export async function verifyPublished(options, { execute = execFileSync, fetchJson = fetchRegistryJson } = {}) {
  try {
    const request = selectors(options), { version, source, npmCli, outputDirectory, sourceRef, expectedSha256 } = request;
    const env = options.env ?? process.env, projectRoot = options.projectRoot ?? defaultRoot;
    requireThat(record(env) && !Object.keys(env).some(key => /^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN|NPM_CONFIG_.*)$/i.test(key)),
      "Legacy npm token/configuration environment overrides are forbidden");
    requireThat(typeof projectRoot === "string" && isAbsolute(projectRoot), "An absolute source checkout is required");
    checkSource(projectRoot, version);
    // Resolve parents for the containment check, including temporary-directory
    // aliases. Fresh private state prevents project/home npmrc or cache reuse.
    const location = join(realpathSync(dirname(outputDirectory)), basename(outputDirectory));
    const within = relative(realpathSync(projectRoot), location);
    requireThat(within !== "" && (within.startsWith(".." + sep) || isAbsolute(within)), "Verification output must be outside the source checkout");
    requireThat(!lstatSync(outputDirectory, { throwIfNoEntry: false }), "Refusing to reuse existing verification output");
    mkdirSync(outputDirectory, { mode: 0o700 });
    const home = join(outputDirectory, "home"), cache = join(outputDirectory, "cache"), audit = join(outputDirectory, "audit");
    const archivesDirectory = join(outputDirectory, "archives"), temporary = join(outputDirectory, "tmp");
    for (const path of [home, cache, audit, archivesDirectory, temporary]) mkdirSync(path, { mode: 0o700 });
    const user = join(outputDirectory, "user.npmrc"), global = join(outputDirectory, "global.npmrc");
    for (const path of [user, global]) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    for (const path of [outputDirectory, audit]) writeFileSync(join(path, "package.json"), JSON.stringify({ name: "public-registry-verification", version: "0.0.0", private: true }), { flag: "wx", mode: 0o600 });
    // Do not inspect/copy ANY caller credential, proxy, Node injection, OIDC or
    // config values. Only these constant, private process settings are inherited.
    const childEnv = { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: cache, APPDATA: home, LOCALAPPDATA: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      CI: "true", NO_COLOR: "1", TERM: "dumb", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
    let head;
    try { head = execute("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectRoot, env: childEnv, encoding: "utf8",
      timeout: 30000, maxBuffer: 1024, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw new PublishedVerificationError("Unable to verify source checkout HEAD"); }
    requireThat(typeof head === "string" && head.trim() === source, "Checkout HEAD differs from expected source commit");
    // Match the flag set that already verified the real public release. Never
    // pass --workspaces=false here: it switches npm audit signatures to the
    // exclude-workspaces dependency filter, which audited only one package.
    const config = ["--registry", registry, "--userconfig", user, "--globalconfig", global, "--cache", cache,
      "--fetch-retries", "0", "--fetch-timeout", String(fetchTimeout), "--no-update-notifier"];
    const run = (args, cwd = outputDirectory) => {
      requireThat(["--version", "view", "pack", "install", "audit"].includes(args[0]) && (args[0] !== "audit" || args[1] === "signatures"), "Only read-only registry commands are allowed");
      let stdout;
      try { stdout = execute(process.execPath, [npmCli, ...args, ...config], { cwd, env: childEnv, encoding: "utf8",
        timeout: 180000, maxBuffer: jsonLimit, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) {
        if (request.allowPartial && args[0] === "view" && explicitView404(error)) return undefined;
        throw new PublishedVerificationError("npm " + args[0] + " failed; verification stopped without retry");
      }
      requireThat(typeof stdout === "string" && Buffer.byteLength(stdout) <= jsonLimit, "Invalid/oversized npm output");
      return stdout;
    };
    requireThat(run(["--version"]).trim() === npmVersion, "Verification requires pinned npm " + npmVersion);
    const receipts = [], missing = [], preflightBindings = new Map();
    for (const kind of kinds) {
      const spec = nameFor(kind) + "@" + version, viewed = run(["view", spec, "--json"]);
      if (viewed === undefined) { missing.push({ kind, name: nameFor(kind), version }); continue; }
      const meta = json(viewed, "public package metadata");
      packageIdentity(meta, kind, version);
      requireThat(kind === "native" || !missing.some(item => item.kind === "native"), "Published adapters require the exact native version; native is unexpectedly missing");
      const dist = meta.dist;
      requireThat(record(dist) && typeof dist.shasum === "string" && /^[a-f0-9]{40}$/.test(dist.shasum) &&
        typeof dist.integrity === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity), "Invalid public package SHA1/SHA512 metadata");
      const tarball = registryUrl(dist.tarball), attestations = registryUrl(dist.attestations?.url, true);
      const packed = json(run(["pack", spec, "--ignore-scripts", "--json", "--pack-destination", archivesDirectory]), "npm pack result");
      const filename = "cursor-harness-provider-" + kind + "-" + version + ".tgz";
      requireThat(Array.isArray(packed) && packed.length === 1 && record(packed[0]) && packed[0].filename === filename &&
        packed[0].name === nameFor(kind) && packed[0].version === version, "Unexpected npm pack identity/filename/inventory");
      const path = join(archivesDirectory, filename), digests = archiveDigests(path);
      checkDigests(digests, expectedSha256[kind], dist);
      const document = await fetchJson(attestations);
      // Also bound injected parsed JSON and reject unbounded/non-JSON schemas.
      json(JSON.stringify(document), "attestation response");
      const producer = verifyProvenance(document, { kind, version, source, sourceRef, sha512: digests.sha512, ...producerSelectors(request, kind) });
      preflightBindings.set(kind, payloadBinding(document));
      renameSync(path, join(archivesDirectory, kind + ".tgz"));
      receipts.push({ kind, name: nameFor(kind), version, file: kind + ".tgz", ...digests, tarball, attestations, producer });
    }
    const hasCommonProducer = () => receipts.length > 0 && receipts.every(item =>
      item.producer.runId === receipts[0].producer.runId && item.producer.runAttempt === receipts[0].producer.runAttempt);
    const requireProducers = () => requireThat(request.allowPartial || request.producers !== undefined || hasCommonProducer(), "Published packages have mixed producer runs/attempts");
    let signatureAudit;
    if (receipts.length > 0) {
      requireProducers();
      const specs = receipts.map(item => item.name + "@" + version);
      run(["install", "--ignore-scripts", "--legacy-peer-deps", "--save-exact", "--no-audit", "--no-fund", ...specs], audit);
      const lock = checkLock(audit, receipts, version);
      // Text first: it reports how many packages were audited at all, which
      // distinguishes tree/filter problems from --json attestation-row gaps.
      signatureAudit = verifySignatureAudit(run(["audit", "signatures"], audit), receipts.length);
      verifyAttestationAudit(run(["audit", "signatures", "--json", "--include-attestations"], audit), receipts, request, preflightBindings);
      requireProducers();
      requireThat(checkLock(audit, receipts, version).equals(lock), "Installed lockfile changed during signature audit");
    }
    // A global selector describes only a common, cryptographically verified
    // producer. Mixed-run reconciliation keeps each package's actual producer.
    const complete = receipts.length === kinds.length;
    const report = { schemaVersion: 1, outcome: complete ? "verified" : receipts.length ? "partial" : "absent", complete, missing,
      repository, version, source, sourceRef, npmVersion,
      ...(hasCommonProducer() ? { sourceRun: receipts[0].producer.runId, sourceAttempt: receipts[0].producer.runAttempt } : {}),
      producers: Object.fromEntries(receipts.map(item => [item.kind, item.producer])), archivesDirectory, packages: receipts,
      ...(signatureAudit === undefined ? {} : { signatureAudit }) };
    requireThat(readdirSync(archivesDirectory).sort().join("\n") === receipts.map(item => item.file).sort().join("\n"), "Unexpected archive directory inventory");
    for (const receipt of receipts) checkDigests(archiveDigests(join(archivesDirectory, receipt.file)), expectedSha256[receipt.kind], receipt);
    writeFileSync(join(outputDirectory, "verification.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return report;
  } catch (error) {
    if (error instanceof PublishedVerificationError) throw error;
    throw new PublishedVerificationError("Published package verification failed; no further actions attempted");
  }
}

export function parseVerifyPublishedArgs(args) {
  const options = {}, keys = { "--version": "version", "--source": "source", "--sha256": "expectedSha256", "--npm-cli": "npmCli",
    "--output": "outputDirectory", "--source-run": "sourceRun", "--source-attempt": "sourceAttempt", "--producers": "producers", "--partial": "allowPartial" };
  for (let i = 0; i < args.length; i += 2) {
    requireThat(Object.hasOwn(keys, args[i]) && typeof args[i + 1] === "string" && args[i + 1] && !args[i + 1].startsWith("--") &&
      !Object.hasOwn(options, keys[args[i]]), "Unknown, duplicate or missing verification argument");
    options[keys[args[i]]] = args[i + 1];
  }
  if (Object.hasOwn(options, "allowPartial")) {
    requireThat(options.allowPartial === "true" || options.allowPartial === "false", "--partial must be true or false");
    options.allowPartial = options.allowPartial === "true";
  }
  const validated = selectors(options);
  return { ...options, allowPartial: validated.allowPartial, expectedSha256: validated.expectedSha256,
    ...(validated.producers === undefined ? {} : { producers: validated.producers }) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyPublished(parseVerifyPublishedArgs(process.argv.slice(2))), null, 2)); }
  catch (error) {
    console.error(error instanceof PublishedVerificationError ? error.message : "Published package verification refused");
    process.exitCode = 1;
  }
}
