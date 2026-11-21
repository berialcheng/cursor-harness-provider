/** Offline version preparation; the tagged publish.yml workflow owns all npm writes. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "berialcheng/cursor-harness-provider";
const remote = "https://github.com/" + repository + ".git";
const initialSource = "fb6089e011b40f89c65bf66a4afcb43791040919";
const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeName = "@cursor-harness-provider/native";
const bindingPaths = ["Cargo.lock", "Cargo.toml", "crates/cursor-core/Cargo.toml", "crates/cursor-node/Cargo.toml"];
export const versionFiles = Object.freeze([
  "package.json", "packages/native/package.json", "packages/pi/package.json", "packages/opencode/package.json",
  "package-lock.json", "Cargo.toml", "crates/cursor-node/Cargo.toml", "Cargo.lock",
  "licenses/locked-target-dependencies.json", "CHANGELOG.md",
]);
const inputFiles = [...versionFiles, "crates/cursor-core/Cargo.toml", "release.config.json"];
const hash = value => createHash("sha256").update(value).digest("hex");
const oid = value => /^[a-f0-9]{40}$/.test(value);
const refused = () => ({ schemaVersion: 1, outcome: "refused" });
export class PrepareReleaseError extends Error {
  constructor(message, audit = refused()) {
    super(message);
    this.name = "PrepareReleaseError";
    this.audit = audit;
  }
}
const requireThat = (condition, message) => { if (!condition) throw new PrepareReleaseError(message); };

export function parsePrepareArgs(args) {
  const options = { force: false, preview: false }, seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i] === "--force" ? "force" : args[i] === "--preview" ? "preview" : undefined;
    requireThat(key && !seen.has(key) && ["true", "false"].includes(args[i + 1]),
      "Only --force true|false and --preview true|false are accepted, once each");
    seen.add(key);
    options[key] = args[i + 1] === "true";
  }
  return options;
}

function assertContext(env, force, preview) {
  requireThat(typeof force === "boolean" && typeof preview === "boolean", "force and preview must be booleans");
  requireThat(env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === repository &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_WORKFLOW_REF === repository + "/.github/workflows/auto-release.yml@refs/heads/main" &&
    ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
  "Preparation requires this repository's main-branch auto-release.yml in GitHub Actions");
  requireThat(oid(env.GITHUB_SHA || "") && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || ""), "A valid source SHA and current GitHub run/attempt are required");
  requireThat(!(preview || force) || env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "Preview and force require an explicit workflow_dispatch");
  requireThat(preview || env.AUTOMATED_NPM_RELEASES === "true", "AUTOMATED_NPM_RELEASES=true is required for publication");
  // Never inspect GH_TOKEN (including its value/presence). gh and its command-local
  // git credential helper alone own authentication. Do not enable tracing here.
}

export function isDistributablePath(path) {
  if (/^(?:\.github|docs?|test|tests)\//i.test(path)) return false;
  if (/^(?:licenses|vendor)\//.test(path) || /(?:^|\/)(?:LICENSE|COPYING|NOTICE|THIRD_PARTY_NOTICES)(?:[.\-]|$)/i.test(path)) return true;
  if (/(?:^|\/)(?:docs?|tests?|__tests__|fixtures|__snapshots__)\//i.test(path) ||
      /\.(?:md|mdx|rst)$/i.test(path) || /\.(?:test|spec)\.[^/]+$/.test(path)) return false;
  return /^(?:crates|packages)\//.test(path) ||
    /^(?:Cargo\.(?:toml|lock)|package(?:-lock)?\.json|npm-shrinkwrap\.json|rust-toolchain(?:\.toml)?|release\.config\.json|\.npmignore)$/.test(path) ||
    (/^scripts\/[^/]+\.mjs$/.test(path) && !/^scripts\/(?:test-|lint-)/.test(path));
}

function versionParts(version) {
  requireThat(typeof version === "string" && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(version),
    "Only stable, canonical major.minor.patch versions are supported");
  const parts = version.split(".").map(Number);
  requireThat(parts.every(Number.isSafeInteger), "Version component exceeds the safe integer range");
  return parts;
}
export function nextVersion(current, messages = []) {
  const parts = versionParts(current);
  const breaking = messages.some(message => /^[a-z][a-z0-9-]*(?:\([^\n)]+\))?!:/i.test(message) ||
    /^BREAKING(?: CHANGE|-CHANGE):[ \t]*\S/m.test(message));
  const feature = messages.some(message => /^feat(?:\([^\n)]+\))?!?:/i.test(message));
  const index = breaking ? (parts[0] === 0 ? 1 : 0) : feature ? 1 : 2;
  parts[index]++;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  const result = parts.join(".");
  versionParts(result);
  return result;
}

/** Locate JSON values without reformatting any unrelated lock/dependency bytes. */
function jsonDocument(source) {
  const value = JSON.parse(source), ranges = new Map();
  let index = 0;
  const white = () => { while (/\s/.test(source[index] || "") && index < source.length) index++; };
  const string = () => {
    const start = index++;
    while (source[index] !== '"') { if (source[index] === "\\") index++; index++; }
    index++;
    return JSON.parse(source.slice(start, index));
  };
  function visit(path) {
    white();
    const start = index;
    if (source[index] === "{") {
      index++; white();
      const keys = new Set();
      while (source[index] !== "}") {
        const key = string();
        requireThat(!keys.has(key), "Duplicate JSON keys are not supported in version inputs");
        keys.add(key); white(); index++; visit([...path, key]); white();
        if (source[index] === "}") break;
        index++; white();
      }
      index++;
    } else if (source[index] === "[") {
      index++; white();
      let item = 0;
      while (source[index] !== "]") {
        visit([...path, item++]); white();
        if (source[index] === "]") break;
        index++; white();
      }
      index++;
    } else if (source[index] === '"') string();
    else while (index < source.length && !/[\s,}\]]/.test(source[index])) index++;
    ranges.set(JSON.stringify(path), [start, index]);
  }
  visit([]);
  return { value, ranges, source };
}
function changeJson(document, changes) {
  const edits = changes.map(([path, before, after]) => {
    const range = document.ranges.get(JSON.stringify(path));
    requireThat(range && JSON.parse(document.source.slice(...range)) === before, "Version/lock input does not match the unified source version");
    return { start: range[0], end: range[1], replacement: JSON.stringify(after) };
  });
  return replaceRanges(document.source, edits);
}
function replaceRanges(source, edits) {
  let result = source, boundary = source.length;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    requireThat(edit.end <= boundary && edit.start < edit.end, "Overlapping version edits are forbidden");
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    boundary = edit.start;
  }
  return result;
}
function unique(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  requireThat(matches.length === 1, "Unsupported or ambiguous " + label);
  return matches[0];
}
function tomlSection(source, name) {
  const header = unique(source, new RegExp("^\\[" + name.replaceAll(".", "\\.") + "\\][ \\t]*\\r?$", "gm"), name + " table");
  const start = header.index + header[0].length;
  const tail = source.slice(start), next = tail.search(/^\[/m);
  return { start, text: next < 0 ? tail : tail.slice(0, next) };
}
function changeTomlVersion(source, section, current, next) {
  const part = tomlSection(source, section);
  const match = unique(part.text, /^version[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*\r?$/gm, section + " version");
  requireThat(match[1] === current, "Cargo workspace version differs from the unified version");
  const start = part.start + match.index + match[0].indexOf('"') + 1;
  return replaceRanges(source, [{ start, end: start + current.length, replacement: next }]);
}
function changeCargoLock(source, current, next) {
  const blocks = [...source.matchAll(/^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm)];
  requireThat(blocks.length > 2, "Cargo.lock must contain local and third-party package records");
  const edits = [], localNames = new Set();
  for (const block of blocks) {
    const name = unique(block[0], /^name = "([^"\r\n]+)"\r?$/gm, "Cargo.lock package name")[1];
    if (["cursor-core", "cursor-node"].includes(name)) {
      requireThat(!localNames.has(name) && !/^(?:source|checksum)[ \t]*=/m.test(block[0]), "Invalid local Cargo.lock package");
      localNames.add(name);
      const version = unique(block[0], /^version = "([^"\r\n]+)"\r?$/gm, "local Cargo.lock version");
      requireThat(version[1] === current, "Local Cargo.lock version differs from the unified version");
      const start = block.index + version.index + version[0].indexOf('"') + 1;
      edits.push({ start, end: start + current.length, replacement: next });
    } else requireThat(/^source = ".+"\r?$/m.test(block[0]), "Unexpected additional local Cargo.lock package");
  }
  requireThat(localNames.size === 2, "Both local Cargo.lock records are required");
  const result = replaceRanges(source, edits);
  // Compare every third-party record as bytes, not parsed/re-serialized TOML.
  const thirdParty = text => [...text.matchAll(/^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm)]
    .filter(block => !/^name = "cursor-(?:core|node)"\r?$/m.test(block[0])).map(block => block[0]).join("");
  requireThat(thirdParty(source) === thirdParty(result), "Third-party Cargo.lock records changed during version preparation");
  return result;
}

/** Pure, all-inputs-first plan. Inputs/outputs are Maps of relative paths to UTF-8 text. */
export function planVersionFiles(inputs, { current, version, commits = [] }) {
  const before = versionParts(current), after = versionParts(version);
  const difference = after.findIndex((part, index) => part !== before[index]);
  requireThat(difference >= 0 && after[difference] > before[difference], "A newer release version is required");
  const get = path => { requireThat(typeof inputs.get(path) === "string", "Missing version input: " + path); return inputs.get(path); };
  const plan = new Map();
  for (const kind of ["root", "native", "pi", "opencode"]) {
    const path = kind === "root" ? "package.json" : "packages/" + kind + "/package.json";
    const document = jsonDocument(get(path));
    requireThat(document.value.name === (kind === "root" ? "cursor-harness-provider" : "@cursor-harness-provider/" + kind), "Unexpected release package identity");
    const changes = [[["version"], current, version]];
    if (["pi", "opencode"].includes(kind)) changes.push([["dependencies", nativeName], current, version]);
    plan.set(path, changeJson(document, changes));
  }
  const npm = jsonDocument(get("package-lock.json"));
  requireThat(npm.value.lockfileVersion === 3 && npm.value.name === "cursor-harness-provider", "npm lockfile v3 for this workspace is required");
  const npmChanges = [[["version"], current, version], [["packages", "", "version"], current, version]];
  for (const kind of ["native", "pi", "opencode"]) {
    const path = "packages/" + kind;
    requireThat(npm.value.packages?.[path] && npm.value.packages["node_modules/@cursor-harness-provider/" + kind]?.link === true &&
      npm.value.packages["node_modules/@cursor-harness-provider/" + kind].resolved === path, "Missing npm workspace/link record");
    npmChanges.push([["packages", path, "version"], current, version]);
    if (kind !== "native") npmChanges.push([["packages", path, "dependencies", nativeName], current, version]);
  }
  const npmResult = changeJson(npm, npmChanges);
  // Mask only the permitted version scalars; all third-party lock bytes must agree.
  const masked = (document, changes, before) => changeJson(document, changes.map(([path]) => [path, before, "__release_version__"]));
  requireThat(masked(npm, npmChanges, current) === masked(jsonDocument(npmResult), npmChanges, version),
    "Third-party npm lock records changed during version preparation");
  plan.set("package-lock.json", npmResult);
  const cargo = get("Cargo.toml");
  requireThat(/members\s*=\s*\[\s*"crates\/cursor-core"\s*,\s*"crates\/cursor-node"\s*\]/.test(tomlSection(cargo, "workspace").text),
    "The two-member Cargo workspace is required");
  plan.set("Cargo.toml", changeTomlVersion(cargo, "workspace.package", current, version));
  for (const kind of ["core", "node"]) {
    const manifest = get("crates/cursor-" + kind + "/Cargo.toml");
    requireThat(new RegExp('^name = "cursor-' + kind + '"$', "m").test(tomlSection(manifest, "package").text) &&
      /^version\.workspace\s*=\s*true\s*$/m.test(tomlSection(manifest, "package").text), "Local crates must inherit the workspace version");
  }
  const node = get("crates/cursor-node/Cargo.toml"), dependencies = tomlSection(node, "dependencies");
  const internal = unique(dependencies.text,
    /^cursor-core[ \t]*=[ \t]*\{[ \t]*path[ \t]*=[ \t]*"\.\.\/cursor-core",[ \t]*version[ \t]*=[ \t]*"=([^"\r\n]+)"[ \t]*\}[ \t]*\r?$/gm, "exact internal Cargo dependency");
  requireThat(internal[1] === current, "The internal Cargo dependency must exactly match the unified version");
  const internalStart = dependencies.start + internal.index + internal[0].lastIndexOf('"=') + 2;
  plan.set("crates/cursor-node/Cargo.toml", replaceRanges(node, [{ start: internalStart, end: internalStart + current.length, replacement: version }]));
  plan.set("Cargo.lock", changeCargoLock(get("Cargo.lock"), current, version));
  const reference = jsonDocument(get("licenses/locked-target-dependencies.json"));
  requireThat(reference.value.schemaVersion === 1 && JSON.stringify(Object.keys(reference.value.sourceBinding || {}).sort()) === JSON.stringify(bindingPaths),
    "Unexpected locked dependency sourceBinding paths");
  const policy = JSON.parse(get("release.config.json"));
  const targets = policy.platforms?.map(platform => platform.target);
  requireThat(policy.repository === repository && Array.isArray(targets) && targets.length > 0 && new Set(targets).size === targets.length &&
    JSON.stringify([...targets].sort()) === JSON.stringify(Object.keys(reference.value.targets || {}).sort()) &&
    targets.every(target => Array.isArray(reference.value.targets[target]) && reference.value.targets[target].length > 0),
  "Locked dependency targets must exactly cover the supported release targets");
  const bindings = bindingPaths.map(path => {
    requireThat(reference.value.sourceBinding[path] === hash(get(path)), "Stale locked dependency sourceBinding; review/regenerate it before preparation");
    return [["sourceBinding", path], hash(get(path)), hash(plan.get(path) || get(path))];
  });
  const referenceResult = changeJson(reference, bindings);
  const hideBindings = (document, offset) => changeJson(document, bindings.map(binding => [binding[0], binding[offset], "__source_hash__"]));
  requireThat(hideBindings(reference, 1) === hideBindings(jsonDocument(referenceResult), 2),
    "Locked third-party records/targets changed during source rebinding");
  plan.set("licenses/locked-target-dependencies.json", referenceResult);
  const changelog = get("CHANGELOG.md");
  requireThat(changelog.startsWith("# Changelog\n\n") && /^## ([^\r\n]+)\r?$/m.exec(changelog)?.[1] === current &&
    !changelog.includes("\n## " + version + "\n"), "Unsupported, drifted or duplicate changelog version");
  const entries = commits.map(commit => {
    requireThat(oid(commit.sha) && typeof commit.message === "string", "Invalid changelog commit");
    const subject = commit.message.split("\n")[0].replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240)
      .replace(/[\\`*_[\]<>]/g, character => "\\" + character);
    return "- " + subject + " (" + commit.sha.slice(0, 7) + ")";
  });
  const entry = "## " + version + "\n\n" + (entries.length ? entries.join("\n") : "- Prepare a coordinated release (explicit force).") + "\n\n";
  plan.set("CHANGELOG.md", "# Changelog\n\n" + entry + changelog.slice("# Changelog\n\n".length));
  requireThat(JSON.stringify([...plan.keys()].sort()) === JSON.stringify([...versionFiles].sort()), "Unexpected version-file plan");
  return plan;
}

function readSource(root, path) {
  let current = root;
  requireThat(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), "A real project directory is required");
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    requireThat(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), "Version inputs cannot contain symlinks or special files");
    requireThat(stat.size <= 16 * 1024 * 1024, "Oversized version input");
  }
  const bytes = readFileSync(current), text = bytes.toString("utf8");
  requireThat(Buffer.from(text).equals(bytes), "Version inputs must be UTF-8 text");
  return text;
}

// Each rename is atomic. Validate and prepare every file first, then roll back
// failed writes; the single Git commit is the atomic multi-file release boundary.
function replaceFiles(root, contents, expected) {
  const temporary = [], installed = [];
  try {
    for (const [path, content] of contents) {
      requireThat(readSource(root, path) === expected.get(path), "Version inputs changed during preparation");
      const destination = join(root, path), temp = join(dirname(destination), ".prepare-release-" + randomUUID());
      writeFileSync(temp, content, { flag: "wx", mode: lstatSync(destination).mode & 0o777 });
      temporary.push({ path, destination, temp });
    }
    for (const file of temporary) {
      requireThat(readSource(root, file.path) === expected.get(file.path), "Version input changed before its atomic replacement");
      renameSync(file.temp, file.destination);
      installed.push(file);
    }
  } catch {
    for (const file of installed.reverse()) {
      // Never overwrite an unexpected concurrent local edit during rollback.
      if (readSource(root, file.path) === contents.get(file.path)) writeFileSync(file.destination, expected.get(file.path));
    }
    throw new PrepareReleaseError("Version-file transaction failed; no release push or dispatch attempted");
  } finally {
    for (const file of temporary) {
      try { unlinkSync(file.temp); } catch (error) { if (error.code !== "ENOENT") throw new PrepareReleaseError("Unable to clean temporary version files"); }
    }
  }
}

const gitConfiguration = [
  "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
  "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
  "-c", "credential.helper=", "-c", "credential.https://github.com.helper=",
  "-c", "credential.https://github.com.helper=!gh auth git-credential",
  "-c", "http.extraHeader=", "-c", "http.https://github.com/.extraHeader=", "-c", "push.followTags=false",
];
/**
 * A plain FF push alone cannot fence a concurrent remote rewind to an ancestor.
 * Verify the server-advertised old OIDs in our own command-local pre-push hook;
 * receive-pack then CASes those same OIDs. No force/lease or repository hook/config
 * changes are needed. The hook reads only Git's ref inventory on stdin.
 */
function withPushFence(source, commit, tag, tagObject, push) {
  const directory = mkdtempSync(join(tmpdir(), "cursor-prepare-push-"));
  try {
    const checker = join(directory, "check.mjs");
    writeFileSync(checker, 'import { readFileSync } from "node:fs";\n' +
      'const expected = ' + JSON.stringify({ source, commit, tag: "refs/tags/" + tag, tagObject }) + ';\n' +
      'const lines = readFileSync(0, "utf8").trim().split("\\n").filter(Boolean).map(line => line.split(" "));\n' +
      'const main = lines.find(line => line[2] === "refs/heads/main");\n' +
      'const tag = lines.find(line => line[2] === expected.tag);\n' +
      'if (lines.length !== 2 || lines.some(line => line.length !== 4) || !main || !tag ||\n' +
      '    main[1] !== expected.commit || main[3] !== expected.source ||\n' +
      '    tag[0] !== expected.tag || tag[1] !== expected.tagObject || tag[3] !== "0".repeat(40)) {\n' +
      '  console.error("Release ref CAS failed; no refs were pushed"); process.exit(1);\n}\n', { flag: "wx", mode: 0o600 });
    const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(directory, "pre-push"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(checker) + ' "$@"\n', { flag: "wx", mode: 0o700 });
    return push(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const samePaths = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const nulPaths = value => value.split("\0").filter(Boolean);

/**
 * git/gh are synchronous (argv, execFileSync options) => UTF-8 stdout boundaries.
 * Inject both in tests. Never retry writes. An existing remote tag is a durable
 * dispatch fence: observe a matching run, or stop for reconciliation, even if an
 * earlier dispatch has not appeared in GitHub's eventually-consistent run list.
 */
export function prepareRelease({ projectRoot = defaultRoot, force = false, preview = false, env = process.env } = {}, {
  git = (args, options) => execFileSync("git", args, options),
  gh = (args, options) => execFileSync("gh", args, options),
} = {}) {
  assertContext(env, force, preview);
  const root = resolve(projectRoot), source = env.GITHUB_SHA, publishNpm = !preview;
  const audit = { schemaVersion: 1, outcome: "refused", repository, source, publishNpm };
  const result = (outcome, extra = {}) => ({ ...audit, outcome, ...extra });
  const fail = message => { throw new PrepareReleaseError(message, { ...audit }); };
  const options = { cwd: root, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000, maxBuffer: 32 * 1024 * 1024 };
  const gitRun = (args, input) => {
    try { return String(git([...gitConfiguration, ...args], input === undefined ? options : { ...options, input })); }
    catch { fail("Git operation failed; stopped without retries or raw child output"); }
  };
  const ghRun = args => {
    try { return String(gh(args, options)); }
    catch { fail("GitHub operation failed; reconcile any existing release before retrying"); }
  };
  function cleanAt(commit) {
    requireThat(gitRun(["rev-parse", "HEAD"]).trim() === commit && gitRun(["status", "--porcelain=v1", "-z", "--untracked-files=all"]) === "",
      "Source HEAD must equal GITHUB_SHA and the entire worktree/index must be clean");
  }
  function localTag(tag) {
    const ref = "refs/tags/" + tag;
    const lines = gitRun(["for-each-ref", "--format=%(refname) %(objectname)", ref]).trim().split("\n").filter(Boolean);
    const match = lines.find(line => line.startsWith(ref + " "));
    if (!match) return undefined;
    const object = match.slice(ref.length + 1);
    requireThat(oid(object), "Invalid local version tag object");
    return object;
  }
  function remoteRefs(tag) {
    const tagRef = "refs/tags/" + tag, wanted = ["refs/heads/main", tagRef, tagRef + "^{}"], refs = {};
    const output = gitRun(["ls-remote", remote, ...wanted]);
    for (const line of output.trim().split("\n").filter(Boolean)) {
      const match = /^([a-f0-9]{40})\t(.+)$/.exec(line);
      requireThat(match && wanted.includes(match[2]) && !Object.hasOwn(refs, match[2]), "Ambiguous remote release refs");
      refs[match[2]] = match[1];
    }
    requireThat(oid(refs["refs/heads/main"] || "") && (!refs[tagRef + "^{}"] || refs[tagRef]), "Remote main/ref state is incomplete");
    return { main: refs["refs/heads/main"], tag: refs[tagRef], commit: refs[tagRef + "^{}"] || refs[tagRef] };
  }
  function versionCommit(commit, plan) {
    requireThat(oid(commit) && gitRun(["rev-list", "--parents", "-n", "1", commit]).trim() === commit + " " + source,
      "Existing release commit must have exactly the accepted source as its parent");
    const changed = nulPaths(gitRun(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", source, commit, "--"]));
    requireThat(samePaths(changed, versionFiles), "Release commit contains changes outside the explicit version-file allowlist");
    for (const [path, content] of plan) requireThat(gitRun(["show", commit + ":" + path]) === content,
      "Existing version commit differs from the validated version plan");
    const entries = gitRun(["ls-tree", "-r", "-z", commit, "--", ...versionFiles]).split("\0").filter(Boolean);
    requireThat(entries.length === versionFiles.length && entries.every(entry => /^100644 blob [a-f0-9]{40}\t/.test(entry)),
      "Version commit files must remain regular, non-executable files");
  }
  function matchingTag(tag, object, commit, plan) {
    const existing = localTag(tag);
    requireThat(!existing || existing === object, "Immutable version tag conflicts with the local tag; nothing was moved");
    if (!existing) {
      // Object-only fetch: no branch/tag movement and no credential persistence.
      gitRun(["fetch", "--no-tags", "--no-write-fetch-head", remote, "refs/tags/" + tag]);
    }
    const text = gitRun(["cat-file", "-p", object]);
    requireThat(text.startsWith("object " + commit + "\ntype commit\ntag " + tag + "\n"), "Version tags must be annotated and bind the release commit");
    const body = text.slice(text.indexOf("\n\n") + 2);
    const prefix = "cursor-harness-provider automated release\n\nRelease-Version: " + audit.version +
      "\nRelease-Source: " + source + "\nRelease-Publish-Npm: " + publishNpm + "\n";
    requireThat(body.startsWith(prefix) && /^Release-Run: [1-9][0-9]*\nRelease-Attempt: [1-9][0-9]*\nRelease-Nonce: [a-f0-9-]{36}\n$/.test(body.slice(prefix.length)),
      "Existing version tag has a different source/publication mode or lacks coordinator bindings");
    versionCommit(commit, plan);
  }
  function publisherRuns(tag, commit) {
    const response = JSON.parse(ghRun(["api", "--hostname", "github.com", "--method", "GET",
      "repos/" + repository + "/actions/workflows/publish.yml/runs", "-f", "head_sha=" + commit,
      "-f", "event=workflow_dispatch", "-f", "per_page=100"]));
    requireThat(Number.isSafeInteger(response.total_count) && response.total_count >= 0 && Array.isArray(response.workflow_runs) &&
      response.total_count === response.workflow_runs.length && response.workflow_runs.length <= 100,
    "Publisher run observation is incomplete; stopped without dispatch");
    const matches = response.workflow_runs.filter(run => run.event === "workflow_dispatch" && run.head_sha === commit && run.head_branch === tag);
    requireThat(matches.every(run => Number.isSafeInteger(run.id) && run.id > 0), "Invalid publisher run identity");
    return matches.map(run => run.id);
  }
  function observeOnly(tag, commit) {
    audit.outcome = "needs-reconciliation";
    const publisherRunIds = publisherRuns(tag, commit);
    if (publisherRunIds.length) return result("publisher-run-observed", { publisherRunIds });
    fail("Matching release tag exists but no publisher run is observable; stopped without redispatch. Reconcile in GitHub before any manual dispatch");
  }

  try {
    requireThat(!env.GH_HOST || env.GH_HOST === "github.com", "Only github.com is permitted");
    requireThat(gitRun(["rev-parse", "--show-toplevel"]).trim() === root, "projectRoot must be the Git repository root");
    cleanAt(source);
    gitRun(["ls-files", "--error-unmatch", "--", ...inputFiles]);
    const inputs = new Map(inputFiles.map(path => [path, readSource(root, path)]));
    const current = jsonDocument(inputs.get("package.json")).value.version;
    versionParts(current);
    const baselineTag = "v" + current, baselineRemote = remoteRefs(baselineTag), baselineLocal = localTag(baselineTag);
    let baseline;
    if (baselineRemote.tag || baselineLocal) {
      requireThat(baselineRemote.tag && baselineLocal === baselineRemote.tag, "Current version tag is missing locally/remotely or differs; fetch full immutable release history");
      baseline = gitRun(["rev-parse", "--verify", "refs/tags/" + baselineTag + "^{commit}"]).trim();
      requireThat(oid(baseline) && baseline === baselineRemote.commit, "Current version tag does not identify the remote baseline");
    } else {
      requireThat(current === "0.3.0", "A published baseline tag is required after the initial 0.3.0 source");
      baseline = gitRun(["rev-parse", "--verify", initialSource + "^{commit}"]).trim();
      requireThat(oid(baseline), "The initial published source must be available in local history");
    }
    gitRun(["merge-base", "--is-ancestor", baseline, source]);
    requireThat(JSON.parse(gitRun(["show", baseline + ":package.json"])).version === current, "Baseline version differs from the current unified version");
    const paths = nulPaths(gitRun(["diff", "--name-only", "--no-renames", "-z", baseline, source, "--"])).filter(isDistributablePath);
    if (!paths.length && !force) return result(baselineRemote.main === source ? "no-distributable-changes" : "superseded");
    const log = paths.length ? gitRun(["log", "--full-history", "--reverse", "--format=%H%x00%B%x00", baseline + ".." + source, "--"]) : "";
    const parts = log.split("\0"), commits = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const sha = parts[index].trim(), message = parts[index + 1].trim();
      requireThat(oid(sha) && message, "Invalid release history");
      // Inspect each accepted commit against its first parent, including merge
      // resolution changes and feature/breaking metadata on merge commits. A
      // path-limited log can simplify such merges away even with --full-history.
      if (gitRun(["show", "--format=", "--name-only", "--no-renames", "--diff-merges=first-parent", "-z", sha, "--", ...paths])) {
        commits.push({ sha, message });
      }
    }
    const version = nextVersion(current, commits.map(commit => commit.message)), tag = "v" + version;
    audit.version = version; audit.tag = tag;
    const plan = planVersionFiles(inputs, { current, version, commits });
    let refs = remoteRefs(tag);
    if (refs.tag) {
      if (refs.main !== refs.commit) {
        if (refs.main !== source) return result("superseded");
        fail("Immutable version tag exists without its atomic main update; reconcile before continuing");
      }
      audit.commit = refs.commit;
      matchingTag(tag, refs.tag, refs.commit, plan);
      return observeOnly(tag, refs.commit);
    }
    if (refs.main !== source) return result("superseded");
    let tagObject = localTag(tag), commit;
    if (tagObject) {
      commit = gitRun(["rev-parse", "--verify", "refs/tags/" + tag + "^{commit}"]).trim();
      matchingTag(tag, tagObject, commit, plan);
    } else {
      // Last source/CAS check immediately before any worktree or index mutation.
      cleanAt(source);
      refs = remoteRefs(tag);
      if (refs.main !== source) return result("superseded");
      requireThat(!refs.tag, "Version tag appeared concurrently; stopped without mutation");
      for (const [path, content] of inputs) requireThat(readSource(root, path) === content, "Version inputs changed before mutation");
      replaceFiles(root, plan, inputs);
      try {
        gitRun(["add", "--", ...versionFiles]);
        requireThat(samePaths(nulPaths(gitRun(["diff", "--cached", "--name-only", "-z"])), versionFiles) &&
          gitRun(["diff", "--name-only", "-z"]) === "" && gitRun(["ls-files", "--others", "--exclude-standard", "-z"]) === "" &&
          gitRun(["rev-parse", "HEAD"]).trim() === source, "Index/worktree changed outside the version-file transaction");
        gitRun(["commit", "--no-verify", "--only", "-m", "chore(release): prepare v" + version +
          "\n\nKeep all distributable package and native source versions coordinated.\n\nRelease-Source: " + source, "--", ...versionFiles]);
        commit = gitRun(["rev-parse", "HEAD"]).trim();
        audit.commit = commit;
        audit.outcome = "needs-reconciliation";
        versionCommit(commit, plan);
        cleanAt(commit);
      } catch (error) {
        // A nonzero commit response can follow a successful local commit. Never
        // reset such a commit or retry it. Roll back only a provably unchanged HEAD.
        if (gitRun(["rev-parse", "HEAD"]).trim() === source) {
          gitRun(["reset", "--quiet", source, "--", ...versionFiles]);
          replaceFiles(root, new Map(versionFiles.map(path => [path, inputs.get(path)])), plan);
        } else audit.outcome = "needs-reconciliation";
        throw error;
      }
      const annotation = "cursor-harness-provider automated release\n\nRelease-Version: " + version +
        "\nRelease-Source: " + source + "\nRelease-Publish-Npm: " + publishNpm + "\nRelease-Run: " + env.GITHUB_RUN_ID +
        "\nRelease-Attempt: " + env.GITHUB_RUN_ATTEMPT + "\nRelease-Nonce: " + randomUUID();
      gitRun(["tag", "--annotate", tag, "--message", annotation, commit]);
      tagObject = localTag(tag);
      requireThat(oid(tagObject || ""), "Unable to establish the immutable local version tag");
    }
    audit.commit = commit;
    audit.outcome = "needs-reconciliation";
    refs = remoteRefs(tag);
    if (refs.tag) {
      requireThat(refs.tag === tagObject && refs.commit === commit, "Immutable version tag was created concurrently; nothing was overwritten");
      if (refs.main !== commit) return result("superseded");
      return observeOnly(tag, commit);
    }
    if (refs.main !== source) return result("superseded");
    try {
      withPushFence(source, commit, tag, tagObject, hooks => gitRun(["-c", "core.hooksPath=" + hooks,
        "push", "--atomic", "--porcelain", remote, commit + ":refs/heads/main", "refs/tags/" + tag + ":refs/tags/" + tag]));
    } catch {
      // No force/lease, no retry, no assumed failure. A failed response may follow
      // an accepted atomic push. An existing tag still fences all redispatches.
      const observed = remoteRefs(tag);
      if (observed.main === commit && observed.tag === tagObject && observed.commit === commit) return observeOnly(tag, commit);
      if (observed.main !== source && !observed.tag) return result("superseded");
      fail("Atomic push outcome uncertain or refused; stopped without retry or publisher dispatch. Reconcile remote main and tag");
    }
    refs = remoteRefs(tag);
    requireThat(refs.tag === tagObject && refs.commit === commit, "Pushed immutable tag could not be verified; no publisher dispatch attempted");
    if (refs.main !== commit) return result("superseded");
    const publisherRunIds = publisherRuns(tag, commit);
    if (publisherRunIds.length) return result("publisher-run-observed", { publisherRunIds });
    refs = remoteRefs(tag);
    requireThat(refs.tag === tagObject && refs.commit === commit, "Release refs changed before publisher dispatch");
    if (refs.main !== commit) return result("superseded");
    try {
      ghRun(["workflow", "run", "publish.yml", "--ref", tag, "-f", "version=" + version,
        "-f", "publish_npm=" + publishNpm, "--repo", repository]);
    } catch {
      return observeOnly(tag, commit);
    }
    return result("publisher-dispatched");
  } catch (error) {
    throw new PrepareReleaseError(error instanceof PrepareReleaseError ? error.message : "Release preparation failed; stopped without retries or raw child output", { ...audit });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(prepareRelease(parsePrepareArgs(process.argv.slice(2))), null, 2)); }
  catch (error) {
    console.error(error instanceof PrepareReleaseError ? error.message : "Release preparation refused");
    console.log(JSON.stringify(error instanceof PrepareReleaseError ? error.audit : refused(), null, 2));
    process.exitCode = 1;
  }
}
