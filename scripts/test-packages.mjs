/** Offline npm tarball acceptance: never publish, stage, read host auth or run install scripts. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageKinds, readNotice, sha256, verifyPackagedLicenses } from "./package-licenses.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "cursor-package-preflight-"));
try {
  const emptyUser = join(temporary, "user.npmrc"), emptyGlobal = join(temporary, "global.npmrc");
  writeFileSync(emptyUser, ""); writeFileSync(emptyGlobal, "");
  const home = join(temporary, "home"); mkdirSync(home);
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    npm_config_userconfig: emptyUser, npm_config_globalconfig: emptyGlobal,
    npm_config_cache: join(temporary, "cache"), npm_config_update_notifier: "false",
  };
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run with npm run test:packages so the existing npm CLI is explicit");
  function npm(args, cwd) {
    return execFileSync(process.execPath, [npmCli, ...args, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", temporary,
    ...packageKinds.flatMap(kind => ["--workspace", "packages/" + kind])], root));
  if (packed.length !== packageKinds.length) throw new Error("Unexpected workspace pack result");
  const summaries = [], archives = [];
  for (const kind of packageKinds) {
    const expected = JSON.parse(readNotice(join(root, "packages", kind), "package.json"));
    const pack = packed.find(item => item.name === expected.name);
    if (!pack || pack.version !== expected.version || !/^[a-zA-Z0-9._-]+[.]tgz$/.test(pack.filename)) throw new Error("Unexpected package artifact");
    const archive = join(temporary, pack.filename);
    archives.push(archive);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    for (const entry of entries) {
      if (!entry.startsWith("package/") || isAbsolute(entry) || entry.includes("\\") || entry.split("/").includes("..")) throw new Error("Unsafe tar entry");
      if (["node_modules", "test", "vendor", "src", "target"].includes(entry.split("/")[1])) throw new Error("Unwanted source/runtime tree in tarball: " + entry);
      if (/\/(?:auth|credentials)[.]json$|\/(?:[.]env|[.]npmrc)(?:$|[.])|[.](?:log|jsonl)$/.test(entry)) throw new Error("Private artifact in tarball");
    }
    const extracted = join(temporary, "unpacked-" + kind); mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    const base = join(extracted, "package");
    const result = verifyPackagedLicenses(base, kind, root);
    const manifest = JSON.parse(readNotice(base, "package.json"));
    if (manifest.version !== expected.version || manifest.private !== expected.private) throw new Error("Packing changed package identity");
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
    summaries.push({ ...result, name: manifest.name, version: manifest.version, files: pack.files.length });
  }

  // npm gets all local tarballs together, with peer auto-install and all hooks disabled.
  const consumer = join(temporary, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "packed-consumer-fixture", private: true, type: "module" }));
  npm(["install", "--legacy-peer-deps", "--no-package-lock", ...archives], consumer);
  const nativeName = JSON.parse(readNotice(join(root, "packages/native"), "package.json")).name;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval",
    "const n=await import(" + JSON.stringify(nativeName) + ");const e=n.createRustEngine();e.shutdown();console.log(n.nativeVersion());"], {
    cwd: consumer,
    env: { ...env, PATH: "", CARGO: "/unavailable/cargo", RUSTC: "/unavailable/rustc" },
    encoding: "utf8", timeout: 15000,
  }).trim();
  const version = JSON.parse(readNotice(root, "package.json")).version;
  if (output !== version) throw new Error("Packed native module did not load the expected version");
  writeFileSync(join(consumer, "check.ts"), "import { nativeVersion, type RustEngine } from " + JSON.stringify(nativeName) + ";\nconst version: string = nativeVersion();\nconst engine: RustEngine | undefined = undefined;\nvoid version; void engine;\n");
  const emptyTypes = join(temporary, "types"); mkdirSync(emptyTypes);
  const tsc = join(root, "node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "--noEmit", "--strict", "--target", "ES2023", "--lib", "ES2023",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--typeRoots", emptyTypes, join(consumer, "check.ts")],
    { cwd: consumer, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log(JSON.stringify({ packages: summaries, offlineInstall: true, lifecycleScriptsDisabled: true,
    nativeLoadWithoutToolchain: output, isolatedTypeConsumer: true }, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }
