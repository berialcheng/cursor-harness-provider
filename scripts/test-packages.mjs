/** Offline tarball/real-host acceptance. No registry writes or host auth stores. */
import { execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageKinds, readNotice, sha256, verifyPackagedLicenses } from "./package-licenses.mjs";
import { extractPackage, isolatedNpm, treeFiles } from "./pack-utils.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
function executable(name) {
  if (isAbsolute(name) || name.includes("/")) {
    const path = resolve(name); accessSync(path, constants.X_OK); return path;
  }
  for (const folder of (process.env.PATH || "").split(delimiter)) {
    const path = join(folder, name);
    try { accessSync(path, constants.X_OK); return path; } catch {}
  }
  throw new Error("Required packed-host executable unavailable: " + name);
}
function packageDirectory(entry, name) {
  let directory = dirname(realpathSync(entry));
  while (directory.includes("/node_modules/")) {
    const file = join(directory, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readNotice(directory, "package.json"));
      if (pkg.name === name) {
        if (!/^1[.][45][.]/.test(pkg.version)) throw new Error("Unverified Pi peer SDK: " + name);
        return directory;
      }
    }
    directory = dirname(directory);
  }
  throw new Error("Cannot resolve provisioned host peer: " + name);
}
function hostPeer(piBinary, name) {
  const host = packageDirectory(piBinary, "@earendil-works/pi-coding-agent");
  if (name === "@earendil-works/pi-coding-agent") return host;
  // These SDKs expose ESM-only exports, so CJS require.resolve is not valid.
  // Follow the selected host installation\'s node_modules ancestry instead.
  let directory = host;
  while (true) {
    const manifest = join(directory, "node_modules", name, "package.json");
    if (existsSync(manifest)) return packageDirectory(manifest, name);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Host peer dependency is not installed: " + name);
}

export function runPackagePreflight({ projectRoot = defaultRoot, archivesDirectory, outputDirectory } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "cursor-package-preflight-"));
  try {
    const npm = isolatedNpm(temporary);
    const packed = archivesDirectory ? null : JSON.parse(npm.run(["pack", "--json", "--pack-destination", temporary,
      ...packageKinds.flatMap(kind => ["--workspace", "packages/" + kind])], projectRoot));
    if (packed && packed.length !== packageKinds.length) throw new Error("Unexpected workspace pack result");
    const summaries = [], archives = [];
    for (const kind of packageKinds) {
      const expected = JSON.parse(readNotice(join(projectRoot, "packages", kind), "package.json"));
      const pack = packed?.find(item => item.name === expected.name);
      if (packed && (!pack || pack.version !== expected.version || !/^[a-zA-Z0-9._-]+[.]tgz$/.test(pack.filename))) throw new Error("Unexpected package artifact");
      const archive = archivesDirectory ? join(archivesDirectory, kind + ".tgz") : join(temporary, pack.filename);
      readNotice(dirname(archive), archive.split("/").pop());
      archives.push(archive);
      const base = extractPackage(archive, join(temporary, "unpacked-" + kind));
      const result = verifyPackagedLicenses(base, kind, projectRoot);
      const manifest = JSON.parse(readNotice(base, "package.json"));
      if (manifest.name !== expected.name || manifest.version !== expected.version || manifest.private !== expected.private ||
          JSON.stringify(manifest.exports) !== JSON.stringify(expected.exports) ||
          JSON.stringify(manifest.dependencies) !== JSON.stringify(expected.dependencies)) throw new Error("Packing changed package identity/API");
      if (kind === "native") {
        if (manifest.exports["."].types !== "./dist/index.d.ts") throw new Error("Native declaration export not configured");
        readNotice(base, "dist/index.d.ts");
        const native = JSON.parse(readNotice(base, "native/manifest.json"));
        for (const [platform, artifact] of Object.entries(native.artifacts)) {
          if (!/^[a-f0-9]{64}$/.test(artifact.sha256) ||
              artifact.file !== "cursor_native." + platform + "." + artifact.sha256.slice(0, 16) + ".node" ||
              sha256(readNotice(base, "native/" + artifact.file)) !== artifact.sha256) throw new Error("Native artifact checksum mismatch");
        }
      }
      summaries.push({ ...result, name: manifest.name, version: manifest.version, files: treeFiles(base).length });
    }

    const consumer = join(temporary, "consumer"); mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "packed-consumer-fixture", private: true, type: "module" }));
    npm.run(["install", "--legacy-peer-deps", "--no-package-lock", ...archives], consumer);
    const installed = kind => join(consumer, "node_modules",
      JSON.parse(readNotice(join(projectRoot, "packages", kind), "package.json")).name);
    for (const kind of packageKinds) if (lstatSync(installed(kind)).isSymbolicLink()) throw new Error("Our package was linked instead of installed from its tarball");
    const nativeName = JSON.parse(readNotice(join(projectRoot, "packages/native"), "package.json")).name;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval",
      "const n=await import(" + JSON.stringify(nativeName) + ");const e=n.createRustEngine();e.shutdown();console.log(n.nativeVersion());"], {
      cwd: consumer, env: { ...npm.env, PATH: "", CARGO: "/unavailable/cargo", RUSTC: "/unavailable/rustc" },
      encoding: "utf8", timeout: 15000,
    }).trim();
    const version = JSON.parse(readNotice(projectRoot, "package.json")).version;
    if (output !== version) throw new Error("Packed native module did not load the expected version");
    writeFileSync(join(consumer, "check.ts"), "import { nativeVersion, type RustEngine } from " + JSON.stringify(nativeName) + ";\nconst version: string = nativeVersion();\nconst engine: RustEngine | undefined = undefined;\nvoid version; void engine;\n");
    const emptyTypes = join(temporary, "types"); mkdirSync(emptyTypes);
    execFileSync(process.execPath, [join(projectRoot, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2023", "--lib", "ES2023",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", emptyTypes, join(consumer, "check.ts")],
      { cwd: consumer, env: npm.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    // Only host-provided SDK peers are linked. All three project packages above
    // remain actual extracted npm tarball installations, never workspace links.
    const piBinary = executable(process.env.CURSOR_NATIVE_PI_BINARY || "pi");
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
      const destination = join(consumer, "node_modules", name); mkdirSync(dirname(destination), { recursive: true });
      if (existsSync(destination)) throw new Error("Unexpected installed peer");
      symlinkSync(hostPeer(piBinary, name), destination, "dir");
    }
    const hostEnv = { ...npm.env,
      PATH: join(projectRoot, "node_modules/.bin") + delimiter + (process.env.PATH || ""),
      OPENCODE_BIN: executable(process.env.OPENCODE_BIN || "opencode"),
      CURSOR_NATIVE_PI_BINARY: piBinary,
      OPENCODE_CURSOR_REQUIRE_HOST: "1", CURSOR_NATIVE_REQUIRE_PI: "1",
      CURSOR_PACKED_OPENCODE_DIRECTORY: installed("opencode"),
      CURSOR_PACKED_PI_EXTENSION: join(installed("pi"), "dist/index.js"),
      CARGO_TARGET_DIR: join(temporary, "unused-cargo-target"), RUSTUP_AUTO_INSTALL: "0",
    };
    const hostOutput = execFileSync(process.execPath, [join(projectRoot, "node_modules/vitest/vitest.mjs"), "run",
      "test/opencode/opencode.test.ts", "test/pi/host.test.ts"],
      // Three sequential 75s cases per host file, plus transform/startup margin.
      { cwd: projectRoot, env: hostEnv, encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (!/6 passed/.test(hostOutput) || /\bskipped\b/.test(hostOutput)) throw new Error("Packed-host flows did not all pass");
    const report = { packages: summaries, offlineInstall: true, lifecycleScriptsDisabled: true,
      nativeLoadWithoutToolchain: output, isolatedTypeConsumer: true,
      packedHostCases: 6, peerSDKs: "external provisioned host peers; not bundled" };
    if (outputDirectory) {
      if (lstatSync(outputDirectory, { throwIfNoEntry: false })) throw new Error("Refusing to overwrite package output directory");
      mkdirSync(outputDirectory, { recursive: true });
      for (let i = 0; i < packageKinds.length; i++) copyFileSync(archives[i], join(outputDirectory, packageKinds[i] + ".tgz"));
      writeFileSync(join(outputDirectory, "preflight.json"), JSON.stringify(report, null, 2) + "\n");
    }
    return report;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--archives", "--output"].includes(args[i]) || !args[i + 1]) throw new Error("Expected --archives/--output path");
    options[args[i] === "--archives" ? "archivesDirectory" : "outputDirectory"] = resolve(args[i + 1]);
  }
  console.log(JSON.stringify(runPackagePreflight(options), null, 2));
}
