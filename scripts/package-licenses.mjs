/** Assemble self-contained package notices. No registry access or license rewriting. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platformForTarget } from "./build-rust.mjs";
import { assertLockedNotices, readNotice, safeParts, sha256 } from "./license-inputs.mjs";
export { classifyDependencies, normalDependencyIds, readNotice, sha256 } from "./license-inputs.mjs";

export const packageKinds = ["native", "pi", "opencode"];
const generator = "cursor-harness-provider/package-licenses-v1";
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
  assertLockedNotices(projectRoot, inventory.target, inventory.dependencies, join(projectRoot, "licenses"));
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
/** Verify a complete license tree, including metadata and exact file membership. */
function verifyLicenseTree(directory, distribution, version, own, upstream) {
  if (distribution.generatedBy !== generator || distribution.version !== version ||
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
  if (!readNotice(directory, "pi-cursor/LICENSE").equals(upstream)) throw new Error("Upstream license changed");
  function visit(path, prefix = "") {
    for (const file of readdirSync(path, { withFileTypes: true })) {
      const name = prefix + file.name;
      if (file.isSymbolicLink()) throw new Error("Unexpected license symlink");
      if (file.isDirectory()) visit(join(path, file.name), name + "/");
      else if (!file.isFile() || !expected.delete(name)) throw new Error("Unexpected license file: " + name);
    }
  }
  const recorded = new Set(expected);
  visit(directory);
  if (expected.size) throw new Error("Missing inventoried license files");
  return recorded;
}
function verifyTargetInventory(directory, distribution, recorded, projectRoot) {
  const inventory = JSON.parse(readNotice(directory, "rust-dependencies.json"));
  const gaps = validateInventory(inventory), platform = platformForTarget(inventory.target);
  assertLockedNotices(projectRoot, inventory.target, inventory.dependencies, directory);
  if (distribution.target !== inventory.target || distribution.platform !== platform ||
      JSON.stringify(distribution.knownBuildToolGaps) !== JSON.stringify(gaps)) throw new Error("Rust inventory coverage mismatch");
  for (const dep of inventory.dependencies) for (const path of dep.notices) {
    if (!recorded.has(path)) throw new Error("Uninventoried Rust license: " + path);
  }
  const fallbacks = JSON.parse(readNotice(directory, "upstream-notices.json"));
  for (const fallback of Object.values(fallbacks)) if (!recorded.has(fallback.file)) throw new Error("Missing upstream fallback text");
  return { target: inventory.target, platform };
}
/** Verify extracted tarball contents against the canonical source and inventory. */
export function verifyPackagedLicenses(base, kind, projectRoot) {
  if (!packageKinds.includes(kind)) throw new Error("Unknown package kind");
  const own = readNotice(base, "LICENSE"), upstream = readNotice(base, "licenses/pi-cursor/LICENSE");
  if (!own.equals(readNotice(projectRoot, "LICENSE")) ||
      !upstream.equals(readNotice(projectRoot, "vendor/pi-cursor/LICENSE"))) throw new Error("Project/upstream license changed");
  if (!readNotice(base, "THIRD_PARTY_NOTICES.md").toString().includes("licenses/pi-cursor/LICENSE")) throw new Error("Upstream notice reference missing");
  const directory = join(base, "licenses"), pkg = JSON.parse(readNotice(base, "package.json"));
  const distribution = JSON.parse(readNotice(directory, "distribution.json"));
  const recorded = verifyLicenseTree(directory, distribution, pkg.version, own, upstream);
  const targets = [];
  if (kind === "native") {
    if (distribution.targets !== undefined) {
      if (!Array.isArray(distribution.targets) || !distribution.targets.length || distribution.target || distribution.platform) throw new Error("Ambiguous target license coverage");
      for (const entry of distribution.targets) {
        if (!/^[a-z0-9-]+$/.test(entry.platform) || entry.directory !== "targets/" + entry.platform ||
            targets.some(target => target.platform === entry.platform)) throw new Error("Invalid target license directory");
        const subdir = join(directory, entry.directory);
        const sub = JSON.parse(readNotice(subdir, "distribution.json"));
        const files = verifyLicenseTree(subdir, sub, pkg.version, own, upstream);
        const target = verifyTargetInventory(subdir, sub, files, projectRoot);
        if (target.platform !== entry.platform || target.target !== entry.target) throw new Error("Target license identity mismatch");
        targets.push(target);
      }
    } else targets.push(verifyTargetInventory(directory, distribution, recorded, projectRoot));
    const binary = JSON.parse(readNotice(base, "native/manifest.json"));
    const expected = targets.map(target => target.platform).sort();
    if (binary.version !== pkg.version || JSON.stringify(Object.keys(binary.artifacts).sort()) !== JSON.stringify(expected)) throw new Error("Uncovered native artifact");
  }
  return { kind, licenseFiles: recorded.size - 1,
    ...(kind === "native" ? targets.length === 1 ? { target: targets[0].target } : { targets: targets.map(target => target.target) } : {}) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(preparePackageLicenses(fileURLToPath(new URL("../", import.meta.url))), null, 2));
}
