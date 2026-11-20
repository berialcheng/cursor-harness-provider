/** Canonical offline package staging. Retained loaded DSOs in source are never changed. */
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { packageKinds, readNotice, sha256, verifyPackagedLicenses } from "./package-licenses.mjs";
import { safeParts } from "./license-inputs.mjs";
import { extractPackage, treeFiles } from "./pack-utils.mjs";

const platforms = /^(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)-(?:gnu|musl)|win32-(?:arm64|x64))$/;
const json = (base, path) => JSON.parse(readNotice(base, path));
export function checkNative(base, { exact = true } = {}) {
  const pkg = json(base, "package.json"), manifest = json(base, "native/manifest.json");
  if (!manifest || manifest.version !== pkg.version || !manifest.artifacts ||
      typeof manifest.artifacts !== "object" || Array.isArray(manifest.artifacts) ||
      !Object.keys(manifest.artifacts).length) throw new Error("Native manifest version/artifacts mismatch");
  const files = new Set(["manifest.json"]);
  for (const [platform, entry] of Object.entries(manifest.artifacts)) {
    if (!platforms.test(platform) || !entry || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        entry.file !== "cursor_native." + platform + "." + entry.sha256.slice(0, 16) + ".node" ||
        sha256(readNotice(base, "native/" + entry.file)) !== entry.sha256) throw new Error("Native binary checksum/platform mismatch");
    files.add(entry.file);
  }
  const actual = treeFiles(join(base, "native"));
  if (exact && JSON.stringify(actual) !== JSON.stringify([...files].sort())) throw new Error("Uninventoried native binary");
  return manifest;
}

export function verifyPackageArtifact(base, kind, projectRoot) {
  if (!packageKinds.includes(kind)) throw new Error("Unknown package kind");
  const manifest = json(base, "package.json"), expected = json(join(projectRoot, "packages", kind), "package.json");
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error("Packing changed package identity/API");
  const allowed = new Set(["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "dist", "licenses", ...(kind === "native" ? ["native"] : [])]);
  const files = treeFiles(base);
  let bytes = 0;
  for (const file of files) {
    if (!allowed.has(file.split("/")[0]) || (file.endsWith(".node") && !file.startsWith("native/"))) throw new Error("Unexpected package artifact: " + file);
    bytes += lstatSync(join(base, file)).size;
    if (bytes > 384 * 1024 * 1024) throw new Error("Package byte budget exceeded");
  }
  for (const file of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) readNotice(base, file);
  function checkExports(value) {
    if (typeof value === "string") {
      if (!value.startsWith("./dist/")) throw new Error("Unsafe package export");
      safeParts(value.slice(2)); readNotice(base, value.slice(2));
    } else if (value && typeof value === "object") Object.values(value).forEach(checkExports);
    else throw new Error("Invalid package export");
  }
  checkExports(manifest.exports);
  if (kind === "pi") {
    if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./dist/extension.ts"])) throw new Error("Pi host shim entry not configured");
    readNotice(base, "dist/extension.ts");
  }
  if (kind === "native") {
    if (manifest.exports?.["."]?.types !== "./dist/index.d.ts") throw new Error("Native declaration export not configured");
    checkNative(base);
  }
  return { ...verifyPackagedLicenses(base, kind, projectRoot), name: manifest.name, version: manifest.version, files: files.length };
}

export function stagePackageArtifact({ source, destination, kind, projectRoot }) {
  if (!packageKinds.includes(kind)) throw new Error("Unknown package kind");
  const withinSource = relative(resolve(source), resolve(destination));
  if (!withinSource || (!isAbsolute(withinSource) && withinSource !== ".." && !withinSource.startsWith("../") && !withinSource.startsWith("..\\"))) throw new Error("Package staging must be outside source");
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error("Refusing to overwrite package staging tree");
  const paths = ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"];
  for (const directory of ["dist", "licenses"]) paths.push(...treeFiles(join(source, directory)).map(path => directory + "/" + path));
  if (kind === "native") {
    // Source may retain multiple same-version generations for already-loaded processes.
    // Only this explicit selection can enter a canonical archive; archives themselves
    // always undergo exact-membership validation and are never silently filtered.
    const manifest = checkNative(source, { exact: false });
    paths.push("native/manifest.json", ...Object.values(manifest.artifacts).map(entry => "native/" + entry.file));
  }
  if (paths.length > 6000) throw new Error("Too many package entries");
  let totalBytes = 0;
  for (const path of paths) {
    safeParts(path);
    const stat = lstatSync(join(source, path));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Linked/non-regular package input");
    totalBytes += stat.size;
    if (stat.size > 128 * 1024 * 1024 || totalBytes > 384 * 1024 * 1024) throw new Error("Package byte budget exceeded");
  }
  mkdirSync(destination, { recursive: true });
  for (const path of paths) {
    const bytes = readNotice(source, path), out = join(destination, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes, { flag: "wx", mode: 0o644 });
  }
  verifyPackageArtifact(destination, kind, projectRoot);
  return destination;
}

export function packPackageArtifact({ source, stagingDirectory, outputDirectory, kind, projectRoot, npm }) {
  stagePackageArtifact({ source, destination: stagingDirectory, kind, projectRoot });
  const packed = JSON.parse(npm.run(["pack", "--json", "--pack-destination", outputDirectory], stagingDirectory));
  const expected = json(source, "package.json"), result = packed[0];
  if (packed.length !== 1 || result.name !== expected.name || result.version !== expected.version ||
      !/^[a-zA-Z0-9._-]+[.]tgz$/.test(result.filename)) throw new Error("Unexpected package artifact");
  const archive = join(outputDirectory, result.filename);
  const unpacked = extractPackage(archive, stagingDirectory + "-packed");
  verifyPackageArtifact(unpacked, kind, projectRoot);
  const files = treeFiles(stagingDirectory);
  if (JSON.stringify(files) !== JSON.stringify(treeFiles(unpacked)) ||
      files.some(path => !readNotice(stagingDirectory, path).equals(readNotice(unpacked, path)))) throw new Error("Packing dropped/changed required package assets");
  return { ...result, archive };
}
