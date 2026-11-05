/** Refresh a source-controlled dependency reference from offline, locked Cargo metadata. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkRustWorkspace, root, runCargo } from "./rust-env.mjs";
import { lockedSourceBinding, metadataDependencyRecords, readNotice, sha256 } from "./license-inputs.mjs";

import { treeFiles } from "./pack-utils.mjs";

checkRustWorkspace();
const policy = JSON.parse(readNotice(root, "release.config.json"));
const targets = {};
for (const item of policy.platforms) {
  if (targets[item.target]) throw new Error("Duplicate locked dependency target");
  const metadata = JSON.parse(runCargo(["metadata", "--locked", "--offline", "--filter-platform", item.target, "--format-version", "1"], { capture: true }));
  targets[item.target] = metadataDependencyRecords(metadata).map(dep => {
    const prefix = "rust/" + dep.name + "-" + dep.version, directory = join(root, "licenses", prefix);
    const notices = existsSync(directory) ? treeFiles(directory).map(path => ({
      path: prefix + "/" + path, sha256: sha256(readNotice(directory, path)),
    })) : [];
    if (!notices.length && !(dep.dependencyScope === "build-or-test" && /^protoc-bin-vendored(?:-|$)/.test(dep.name))) {
      throw new Error("Collect/review canonical notice texts from the exact locked crate before refreshing: " + dep.name);
    }
    return { ...dep, notices };
  });
}
const reference = { schemaVersion: 1, sourceBinding: lockedSourceBinding(root), targets };
writeFileSync(join(root, "licenses/locked-target-dependencies.json"), JSON.stringify(reference, null, 2) + "\n");
console.log(JSON.stringify({ lockedTargetDependencies: Object.fromEntries(Object.entries(targets).map(([target, deps]) => [target, deps.length])) }, null, 2));
