import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const cargoBin = join(resolve(process.env.CARGO_HOME || join(homedir(), ".cargo")), "bin");
export function findExistingRustTool(name, preferredBin = cargoBin, searchPath = process.env.PATH || "") {
  const executable = name + (process.platform === "win32" ? ".exe" : "");
  for (const directory of [preferredBin, ...searchPath.split(delimiter)]) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      // Keep the proxy basename: resolving cargo -> rustup changes argv[0].
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* Only existing executables qualify; never download tooling. */ }
  }
  return undefined;
}
// Keep imports usable for Node-only preflight; actual Rust commands validate
// availability in run(). Hosted images may put proxies outside ~/.cargo/bin.
export const cargo = findExistingRustTool("cargo") || join(cargoBin, "cargo");
const rustc = findExistingRustTool("rustc") || join(cargoBin, "rustc");
const cacheKey = path => createHash("sha256").update(path).digest("hex").slice(0, 16);
// CARGO_TARGET_DIR can explicitly reuse an existing cache after a checkout move.
// The default is project-local in identity, but stays outside the watched source.
export const targetDir = resolve(root, process.env.CARGO_TARGET_DIR ||
  join(homedir(), ".cache", "cursor-harness-provider-build", cacheKey(root))
);

function physicalPath(path) {
  let ancestor = path;
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Cannot resolve Cargo target directory");
    suffix.unshift(relative(parent, ancestor));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}
const targetRelative = relative(root, physicalPath(targetDir));
if (!targetRelative || (!isAbsolute(targetRelative) && targetRelative !== ".." && !targetRelative.startsWith(".." + sep))) {
  throw new Error("CARGO_TARGET_DIR must be outside the repository; no watched/root target directory is allowed");
}

export const rustEnv = {
  ...process.env,
  PATH: cargoBin + delimiter + (process.env.PATH || ""),
  CARGO_TARGET_DIR: targetDir,
  // rustup must fail with an actionable error, never download a toolchain.
  RUSTUP_AUTO_INSTALL: "0",
};

function run(binary, args, capture) {
  accessSync(binary, constants.X_OK);
  const result = spawnSync(binary, args, {
    cwd: root, env: rustEnv,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error("Cannot run existing Rust toolchain: " + result.error.message);
  if (result.status !== 0) throw new Error(binary + " " + args.join(" ") + " failed (" + (result.status ?? result.signal) + ")");
  return result.stdout || "";
}
export function runCargo(args, { capture = false } = {}) {
  return run(cargo, args, capture);
}

export function checkRustWorkspace() {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    const path = join(root, "packages", entry.name, "package.json");
    if (entry.isDirectory() && existsSync(path) && JSON.parse(readFileSync(path, "utf8")).version !== version) {
      throw new Error("Package version differs from root: " + path);
    }
  }
  const cargoVersion = run(cargo, ["--version"], true).trim();
  const rustVersion = run(rustc, ["--version"], true).trim();
  const metadata = JSON.parse(runCargo(["metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"], { capture: true }));
  for (const pkg of metadata.packages) {
    if (metadata.workspace_members.includes(pkg.id) && pkg.version !== version) throw new Error("Cargo version differs from root: " + pkg.name);
  }
  if (physicalPath(metadata.target_directory) !== physicalPath(targetDir)) throw new Error("Cargo did not use the external target directory");
  const host = run(rustc, ["-vV"], true).match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error("Cannot identify existing Rust host target");
  console.log("Using " + cargoVersion + "; " + rustVersion + "\nExternal Cargo target: " + targetDir);
  return { version, host };
}

export function isMain(url) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(url);
}
