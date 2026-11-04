/** Conservative locked target dependency notice inventory; not legal advice or a runtime-only SBOM. */
import { mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { root, checkRustWorkspace, runCargo } from "./rust-env.mjs";
import { classifyDependencies } from "./package-licenses.mjs";
const { host } = checkRustWorkspace();
const target = process.env.CARGO_BUILD_TARGET || host;
const metadata = JSON.parse(runCargo(["metadata", "--locked", "--offline", "--filter-platform", target, "--format-version", "1"], { capture: true }));
const dependencyScopes = classifyDependencies(metadata);
const out = join(root, "licenses", "rust");
mkdirSync(out, { recursive: true });
const inventory = [];
const fallbacks = JSON.parse(readFileSync(join(root, "licenses", "upstream-notices.json"), "utf8"));
const allowed = new Set(["MIT", "Apache-2.0", "ISC", "Unicode-3.0", "Unlicense", "Zlib", "BSD-3-Clause", "BSL-1.0", "LLVM-exception"]);
for (const pkg of metadata.packages.filter(p => p.source).sort((a,b) => (a.name + a.version).localeCompare(b.name + b.version))) {
  const ids = (pkg.license ?? "").match(/[A-Za-z][A-Za-z0-9.-]*/g)?.filter(x => !["AND", "OR", "WITH"].includes(x)) ?? [];
  if (!ids.length || ids.some(x => !allowed.has(x))) throw new Error("Review unapproved/missing license expression: " + pkg.name + " " + pkg.license);
  const dir = dirname(pkg.manifest_path), files = [];
  function visit(path, depth) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory() && depth < 3 && !["target", "node_modules", ".git"].includes(entry.name)) visit(file, depth + 1);
      else if (entry.isFile() && /^(license|licence|copying|notice|copyright)([._-]|$)/i.test(entry.name)) files.push(file);
    }
  }
  visit(dir, 0);
  if (pkg.license_file) {
    const file = resolve(dir, pkg.license_file), rel = relative(dir, file);
    if (rel.startsWith("..") || !existsSync(file)) throw new Error("License file outside published crate: " + pkg.name);
    if (!files.includes(file)) files.push(file);
  }
  const names = [];
  for (const file of files.sort()) {
    const rel = relative(dir, file), target = join(out, pkg.name + "-" + pkg.version, rel);
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target);
    names.push(relative(join(root, "licenses"), target).split("\\").join("/"));
  }
  const fallback = fallbacks[pkg.name + "@" + pkg.version];
  if (!names.length && fallback) {
    const source = resolve(root, "licenses", fallback.file);
    if (!source.startsWith(join(root, "licenses") + "/")) throw new Error("Invalid upstream notice path");
    const target = join(out, pkg.name + "-" + pkg.version, "LICENSE");
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
    names.push(relative(join(root, "licenses"), target).split("\\\\").join("/"));
  }
  inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.source,
    dependencyScope: dependencyScopes.get(pkg.id) || "inactive",
    notices: names, ...(fallback ? { noticeOrigin: fallback.url } : {}),
    noticeStatus: names.length ? "upstream files copied" : "SPDX metadata only; notice text missing, binary redistribution review required" });
}
writeFileSync(join(root, "licenses", "rust-dependencies.json"), JSON.stringify({
  target, scope: "Conservative Cargo.lock target inventory, includes build/test dependencies, not an exact runtime-link SBOM",
  dependencies: inventory,
}, null, 2) + "\n");
console.log(JSON.stringify({ target, dependencies: inventory.length, noticeFiles: inventory.reduce((n,p) => n + p.notices.length, 0),
  missingNoticeFiles: inventory.filter(p => !p.notices.length).map(p => p.name + "@" + p.version) }, null, 2));
