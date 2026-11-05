/** Trusted source inputs for notice verification; never derived from a supplied tarball. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function safeParts(path) {
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
    if (i === parts.length - 1 && stat.size > 128 * 1024 * 1024) throw new Error("Oversized package/notice file");
  }
  const bytes = readFileSync(current);
  if (!bytes.length) throw new Error("Empty notice: " + path);
  return bytes;
}

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

export function lockedSourceBinding(projectRoot) {
  const paths = ["Cargo.lock", "Cargo.toml"];
  for (const entry of readdirSync(join(projectRoot, "crates"), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Symlinked workspace manifest directory");
    if (entry.isDirectory() && existsSync(join(projectRoot, "crates", entry.name, "Cargo.toml"))) {
      paths.push("crates/" + entry.name + "/Cargo.toml");
    }
  }
  return Object.fromEntries(paths.sort().map(path => [path, sha256(readNotice(projectRoot, path))]));
}
export function dependencyRecords(dependencies) {
  const identities = new Set();
  return dependencies.map(dep => {
    if (!dep.name || !dep.version || !dep.source || !dep.license ||
        !["normal", "build-or-test", "inactive"].includes(dep.dependencyScope)) throw new Error("Invalid locked dependency record");
    const identity = JSON.stringify([dep.name, dep.version, dep.source]);
    if (identities.has(identity)) throw new Error("Duplicate locked dependency");
    identities.add(identity);
    return { name: dep.name, version: dep.version, source: dep.source, license: dep.license, dependencyScope: dep.dependencyScope };
  }).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
export function metadataDependencyRecords(metadata) {
  const scopes = classifyDependencies(metadata);
  return dependencyRecords(metadata.packages.filter(pkg => pkg.source).map(pkg => ({
    ...pkg, dependencyScope: scopes.get(pkg.id) || "inactive",
  })));
}
export function lockedTargetDependencies(projectRoot, target) {
  const reference = JSON.parse(readNotice(projectRoot, "licenses/locked-target-dependencies.json"));
  if (reference.schemaVersion !== 1 ||
      JSON.stringify(reference.sourceBinding) !== JSON.stringify(lockedSourceBinding(projectRoot))) {
    throw new Error("Stale locked dependency reference; regenerate with npm run licenses:lock");
  }
  const dependencies = reference.targets?.[target];
  if (!Array.isArray(dependencies) || !dependencies.length) throw new Error("Missing locked target dependency set: " + target);
  return dependencyRecords(dependencies);
}
export function assertLockedDependencies(projectRoot, target, dependencies) {
  if (JSON.stringify(dependencyRecords(dependencies)) !== JSON.stringify(lockedTargetDependencies(projectRoot, target))) {
    throw new Error("Rust inventory differs from locked target dependency set: " + target);
  }
}
