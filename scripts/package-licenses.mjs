/** Assemble self-contained package notices. No registry access or license rewriting. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platformForTarget } from "./build-rust.mjs";

export const packageKinds = ["native", "pi", "opencode"];
const generator = "cursor-harness-provider/package-licenses-v1";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Normal edges conservatively include proc macros/codegen. This is not a link SBOM.
function dependencyIds(metadata, normalOnly) {
  if (!metadata.resolve?.nodes || !metadata.workspace_members?.length) throw new Error("Cargo dependency graph required");
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const visited = new Set(), queue = [...metadata.workspace_members];
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (!node) throw new Error("Incomplete Cargo dependency graph: " + id);
    for (const dep of node.deps) if (!normalOnly || dep.dep_kinds.some(kind => kind.kind === null)) queue.push(dep.pkg);
  }
  return visited;
}
export const normalDependencyIds = metadata => dependencyIds(metadata, true);
export function classifyDependencies(metadata) {
  const normal = normalDependencyIds(metadata), reachable = dependencyIds(metadata, false);
  return new Map(metadata.resolve.nodes.map(node => [node.id,
    normal.has(node.id) ? "normal" : reachable.has(node.id) ? "build-or-test" : "inactive"]));
}

function safeParts(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") ||
      path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Unsafe notice path: " + path);
  }
  return path.split("/");
}
export function readNotice(base, path) {
  const parts = safeParts(path);
  let current = base;
  if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error("Unsafe notice directory");
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error("Non-regular notice path: " + path);
    }
  }
  const bytes = readFileSync(current);
  if (!bytes.length) throw new Error("Empty notice: " + path);
  return bytes;
}

export function validateInventory(inventory) {
  if (!inventory.target || !Array.isArray(inventory.dependencies) || !inventory.dependencies.length) throw new Error("Invalid Rust license inventory");
  const gaps = [];
  for (const dep of inventory.dependencies) {
    if (!dep.name || !dep.version || !dep.license || !Array.isArray(dep.notices) ||
        !["normal", "build-or-test", "inactive"].includes(dep.dependencyScope)) throw new Error("Unclassified Rust dependency: " + dep.name);
    for (const path of dep.notices) safeParts(path);
    if (!dep.notices.length) {
      // An explicit exception for the known non-distributed protoc build tools,
      // never for an unknown or normal dependency missing its license text.
      if (dep.dependencyScope !== "build-or-test" || !/^protoc-bin-vendored(?:-[a-z0-9_]+(?:-[a-z0-9_]+)*)?$/.test(dep.name)) {
        throw new Error("Missing third-party license text: " + dep.name + "@" + dep.version);
      }
      gaps.push(dep.name + "@" + dep.version);
    }
  }
  return gaps.sort();
}

export function preparePackageLicenses(projectRoot) {
  const project = JSON.parse(readNotice(projectRoot, "package.json"));
  const ownLicense = readNotice(projectRoot, "LICENSE");
  if (project.license !== "MIT" || !ownLicense.toString().startsWith("MIT License")) throw new Error("Review changed project license");
  const upstreamLicense = readNotice(projectRoot, "vendor/pi-cursor/LICENSE");
  const nativeManifest = JSON.parse(readNotice(projectRoot, "packages/native/native/manifest.json"));
  const inventoryBytes = readNotice(projectRoot, "licenses/rust-dependencies.json");
  const inventory = JSON.parse(inventoryBytes);
  const knownBuildToolGaps = validateInventory(inventory);
  const platform = platformForTarget(inventory.target);
  if (nativeManifest.version !== project.version || !nativeManifest.artifacts?.[platform]) throw new Error("Native/license target or version mismatch");
  // A future multi-target aggregator must supply merged target-specific inventories.
  const uncovered = Object.keys(nativeManifest.artifacts).filter(key => key !== platform);
  if (uncovered.length) throw new Error("Missing target-specific license inventories: " + uncovered.join(", "));

  const rustFiles = new Map([["rust-dependencies.json", inventoryBytes]]);
  for (const dep of inventory.dependencies) for (const path of dep.notices) rustFiles.set(path, readNotice(join(projectRoot, "licenses"), path));
  const fallbackBytes = readNotice(projectRoot, "licenses/upstream-notices.json");
  rustFiles.set("upstream-notices.json", fallbackBytes);
  for (const fallback of Object.values(JSON.parse(fallbackBytes))) rustFiles.set(fallback.file, readNotice(join(projectRoot, "licenses"), fallback.file));

  // Validate all inputs before modifying generated package outputs.
  for (const kind of packageKinds) {
    const base = join(projectRoot, "packages", kind);
    const pkg = JSON.parse(readNotice(base, "package.json"));
    if (pkg.version !== project.version || pkg.license !== "MIT") throw new Error("Package version/license mismatch: " + kind);
    readNotice(base, "THIRD_PARTY_NOTICES.md");
    const destination = join(base, "licenses");
    let previous;
    // lstat also detects dangling links; existsSync would miss them and permit
    // writeFileSync to follow a dangling LICENSE link outside the package.
    if (lstatSync(destination, { throwIfNoEntry: false })) {
      previous = JSON.parse(readNotice(destination, "distribution.json"));
      if (previous.generatedBy !== generator) throw new Error("Refusing to replace unmanaged license directory: " + kind);
    }
    const ownPath = join(base, "LICENSE");
    if (lstatSync(ownPath, { throwIfNoEntry: false })) {
      const bytes = readNotice(base, "LICENSE");
      if (previous ? sha256(bytes) !== previous.projectLicenseSha256 : !bytes.equals(ownLicense)) {
        throw new Error("Refusing to overwrite modified package LICENSE: " + kind);
      }
    }
  }

  const result = [];
  for (const kind of packageKinds) {
    const base = join(projectRoot, "packages", kind);
    const files = new Map([["pi-cursor/LICENSE", upstreamLicense]]);
    if (kind === "native") for (const [path, bytes] of rustFiles) files.set(path, bytes);
    const distribution = {
      generatedBy: generator, version: project.version,
      projectLicenseSha256: sha256(ownLicense),
      upstreamLicenseSha256: sha256(upstreamLicense),
      ...(kind === "native" ? { target: inventory.target, platform, knownBuildToolGaps } : {}),
      files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    };
    const temporary = mkdtempSync(join(base, ".package-licenses-"));
    try {
      for (const [path, bytes] of files) {
        const file = join(temporary, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
      writeFileSync(join(temporary, "distribution.json"), JSON.stringify(distribution, null, 2) + "\n");
      rmSync(join(base, "licenses"), { recursive: true, force: true });
      renameSync(temporary, join(base, "licenses"));
      writeFileSync(join(base, "LICENSE"), ownLicense);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    result.push({ package: kind, licenseFiles: files.size, ...(kind === "native" ? { target: inventory.target, knownBuildToolGaps } : {}) });
  }
  return result;
}
/** Verify extracted tarball contents against the canonical source and inventory. */
export function verifyPackagedLicenses(base, kind, projectRoot) {
  if (!packageKinds.includes(kind)) throw new Error("Unknown package kind");
  const own = readNotice(base, "LICENSE"), upstream = readNotice(base, "licenses/pi-cursor/LICENSE");
  if (!own.equals(readNotice(projectRoot, "LICENSE")) ||
      !upstream.equals(readNotice(projectRoot, "vendor/pi-cursor/LICENSE"))) throw new Error("Project/upstream license changed");
  const notice = readNotice(base, "THIRD_PARTY_NOTICES.md").toString();
  if (!notice.includes("licenses/pi-cursor/LICENSE")) throw new Error("Upstream notice reference missing");
  const directory = join(base, "licenses");
  const distribution = JSON.parse(readNotice(directory, "distribution.json"));
  const pkg = JSON.parse(readNotice(base, "package.json"));
  if (distribution.generatedBy !== generator || distribution.version !== pkg.version ||
      distribution.projectLicenseSha256 !== sha256(own) || distribution.upstreamLicenseSha256 !== sha256(upstream)) {
    throw new Error("Invalid distribution license manifest");
  }
  const expected = new Set(["distribution.json"]);
  for (const file of distribution.files) {
    if (expected.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid license file record");
    expected.add(file.path);
    if (sha256(readNotice(directory, file.path)) !== file.sha256) throw new Error("License checksum mismatch: " + file.path);
  }
  if (!expected.has("pi-cursor/LICENSE")) throw new Error("Upstream license not inventoried");
  function visit(path, prefix = "") {
    for (const file of readdirSync(path, { withFileTypes: true })) {
      const name = prefix + file.name;
      if (file.isSymbolicLink()) throw new Error("Unexpected license symlink");
      if (file.isDirectory()) visit(join(path, file.name), name + "/");
      else if (!file.isFile() || !expected.delete(name)) throw new Error("Unexpected license file: " + name);
    }
  }
  // Keep the original set for reference validation below.
  const recorded = new Set(expected);
  visit(directory);
  if (expected.size) throw new Error("Missing inventoried license files");
  if (kind === "native") {
    const inventory = JSON.parse(readNotice(directory, "rust-dependencies.json"));
    const gaps = validateInventory(inventory), platform = platformForTarget(inventory.target);
    if (distribution.target !== inventory.target || distribution.platform !== platform ||
        JSON.stringify(distribution.knownBuildToolGaps) !== JSON.stringify(gaps)) throw new Error("Rust inventory coverage mismatch");
    for (const dep of inventory.dependencies) for (const path of dep.notices) {
      if (!recorded.has(path)) throw new Error("Uninventoried Rust license: " + path);
    }
    const fallbacks = JSON.parse(readNotice(directory, "upstream-notices.json"));
    for (const fallback of Object.values(fallbacks)) if (!recorded.has(fallback.file)) throw new Error("Missing upstream fallback text");
    const binary = JSON.parse(readNotice(base, "native/manifest.json"));
    if (binary.version !== pkg.version || Object.keys(binary.artifacts).some(key => key !== platform) || !binary.artifacts[platform]) {
      throw new Error("Uncovered native artifact");
    }
  }
  return { kind, licenseFiles: recorded.size - 1, ...(kind === "native" ? { target: distribution.target } : {}) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(preparePackageLicenses(fileURLToPath(new URL("../", import.meta.url))), null, 2));
}
