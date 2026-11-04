import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { checkRustWorkspace, isMain, root, runCargo } from "./rust-env.mjs";

export function platformForTarget(target) {
  const arch = target.startsWith("aarch64-") ? "arm64" : target.startsWith("x86_64-") ? "x64" : undefined;
  if (!arch) throw new Error("Unsupported native target architecture: " + target);
  if (target.includes("-apple-darwin")) return "darwin-" + arch;
  if (target.includes("-unknown-linux-gnu")) return "linux-" + arch + "-gnu";
  if (target.includes("-unknown-linux-musl")) return "linux-" + arch + "-musl";
  if (target.includes("-pc-windows-msvc")) return "win32-" + arch;
  throw new Error("Unsupported native target: " + target);
}

// Exported for offline packaging fixture tests. Content-addressed files are never
// removed: loaded libraries and artifacts for other platforms must remain valid.
export function packageArtifact({ source, platform, version, directory }) {
  if (!/^[a-z0-9-]+$/.test(platform)) throw new Error("Invalid native platform");
  const bytes = readFileSync(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = "cursor_native." + platform + "." + sha256.slice(0, 16) + ".node";
  const manifestPath = join(directory, "manifest.json");
  let manifest = { version, artifacts: {} };
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.version !== version || !manifest.artifacts || typeof manifest.artifacts !== "object" || Array.isArray(manifest.artifacts)) {
      throw new Error("Existing native manifest is incompatible; refusing to discard other platforms");
    }
    for (const [key, entry] of Object.entries(manifest.artifacts)) {
      if (!/^[a-z0-9-]+$/.test(key) || !entry || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          entry.file !== "cursor_native." + key + "." + entry.sha256.slice(0, 16) + ".node") {
        throw new Error("Invalid existing native artifact entry: " + key);
      }
    }
  }
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, file);
  if (existsSync(destination) && createHash("sha256").update(readFileSync(destination)).digest("hex") !== sha256) {
    throw new Error("Native artifact hash-prefix collision; refusing to overwrite");
  }
  const nonce = process.pid + "." + randomUUID();
  const temporaryArtifact = destination + "." + nonce + ".tmp";
  const temporaryManifest = manifestPath + "." + nonce + ".tmp";
  try {
    if (!existsSync(destination)) {
      writeFileSync(temporaryArtifact, bytes, { flag: "wx", mode: 0o644 });
      renameSync(temporaryArtifact, destination);
    }
    manifest.artifacts[platform] = { file, sha256 };
    writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 });
    renameSync(temporaryManifest, manifestPath);
  } finally {
    rmSync(temporaryArtifact, { force: true });
    rmSync(temporaryManifest, { force: true });
  }
  return { file, sha256 };
}

export function buildRust() {
  const { version, host } = checkRustWorkspace();
  const target = process.env.CARGO_BUILD_TARGET || host;
  const platform = platformForTarget(target);
  const output = runCargo(["build", "--locked", "--release", "--package", "cursor-node", "--message-format=json-render-diagnostics"], { capture: true });
  const artifacts = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(message =>
    message.reason === "compiler-artifact" && message.target.name === "cursor_node" && message.target.crate_types.includes("cdylib"));
  const filenames = artifacts.flatMap(artifact => artifact.filenames).filter(path => /[.](dylib|so|dll)$/.test(path));
  if (filenames.length !== 1) throw new Error("Cargo did not produce exactly one cursor-node dynamic library");
  const entry = packageArtifact({ source: filenames[0], platform, version, directory: join(root, "packages/native/native") });
  console.log("Built " + basename(filenames[0]) + " -> packages/native/native/" + entry.file + "\nSHA-256 " + entry.sha256 + " (version " + version + ")");
}
if (isMain(import.meta.url)) buildRust();
