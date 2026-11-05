/** Read-only-registry release preflight. Commands export/aggregate/verify never publish. */
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageKinds, readNotice, sha256, verifyPackagedLicenses } from "./package-licenses.mjs";
import { platformForTarget } from "./build-rust.mjs";
import { copyTree, extractPackage, isolatedNpm, treeFiles } from "./pack-utils.mjs";
import { runPackagePreflight } from "./test-packages.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const json = (base, path) => JSON.parse(readNotice(base, path));
export function releaseSource(projectRoot) {
  const policy = json(projectRoot, "release.config.json"), project = json(projectRoot, "package.json");
  if (policy.schemaVersion !== 1 || policy.registry !== "https://registry.npmjs.org/" || !project.private ||
      !/^[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(project.version)) throw new Error("Invalid release policy/version");
  const platforms = new Set();
  for (const item of policy.platforms) {
    if (platforms.has(item.platform) || platformForTarget(item.target) !== item.platform || !item.runner) throw new Error("Invalid release platform policy");
    platforms.add(item.platform);
  }
  if (!platforms.size) throw new Error("Release platforms required");
  for (const kind of packageKinds) {
    const pkg = json(join(projectRoot, "packages", kind), "package.json");
    if (pkg.name !== policy.packages[kind] || pkg.version !== project.version || pkg.private !== false ||
        pkg.publishConfig?.access !== "public" || pkg.publishConfig?.registry !== policy.registry ||
        pkg.repository?.url !== "git+https://github.com/" + policy.repository + ".git" ||
        pkg.repository?.directory !== "packages/" + kind ||
        (kind !== "native" && pkg.dependencies?.[policy.packages.native] !== project.version)) throw new Error("Unprepared release package: " + kind);
    for (const name of Object.keys(pkg.scripts || {})) if (/^(?:preinstall|install|postinstall|prepare|prepack|postpack|prepublish|prepublishOnly|publish|postpublish)$/.test(name)) throw new Error("Unexpected package lifecycle script");
  }
  const cargo = readNotice(projectRoot, "Cargo.toml").toString().split("[workspace.package]")[1]?.split(/\n\[/)[0];
  if (cargo?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] !== project.version) throw new Error("Cargo/npm release version mismatch");
  for (const pkg of Object.values(json(projectRoot, "package-lock.json").packages || {})) {
    if (pkg.resolved && !pkg.link && !pkg.resolved.startsWith("https://registry.npmjs.org/")) throw new Error("Non-public npm lockfile source");
  }
  return { policy, version: project.version };
}
export function sourceIdentity(projectRoot, localOnly = false) {
  if (localOnly && process.env.CI) throw new Error("Local-only release parts are forbidden in CI");
  if (!localOnly && (process.env.GITHUB_ACTIONS !== "true" || !process.env.GITHUB_RUN_ID)) throw new Error("Use --local outside a GitHub Actions run");
  const policy = json(projectRoot, "release.config.json");
  if (!localOnly && process.env.GITHUB_REPOSITORY !== policy.repository) throw new Error("Unexpected release source repository");
  const git = args => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(commit) || (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)) throw new Error("Unexpected release source commit");
  const changes = git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
  if (!localOnly && changes.some(line => line.trim().slice(2).trim() !== "licenses/rust-dependencies.json")) throw new Error("Release source is dirty; use --local only for non-release development evidence");
  return { commit, npmLockSha256: sha256(readNotice(projectRoot, "package-lock.json")),
    cargoLockSha256: sha256(readNotice(projectRoot, "Cargo.lock")),
    runId: process.env.GITHUB_RUN_ID || "local", runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1", localOnly };
}
export function assertIdentity(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Mixed release source/run identity");
}
function newOutput(path) {
  if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("Refusing to overwrite release output");
  mkdirSync(path, { recursive: true });
}
function checkNative(base) {
  const pkg = json(base, "package.json"), manifest = json(base, "native/manifest.json");
  if (manifest.version !== pkg.version || !Object.keys(manifest.artifacts).length) throw new Error("Native manifest version mismatch");
  const files = new Set(["manifest.json"]);
  for (const [platform, entry] of Object.entries(manifest.artifacts)) {
    if (!/^[a-z0-9-]+$/.test(platform) || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        entry.file !== "cursor_native." + platform + "." + entry.sha256.slice(0,16) + ".node" ||
        sha256(readNotice(join(base, "native"), entry.file)) !== entry.sha256) throw new Error("Native binary checksum mismatch");
    files.add(entry.file);
  }
  if (JSON.stringify(treeFiles(join(base, "native"))) !== JSON.stringify([...files].sort())) throw new Error("Uninventoried native binary");
  return manifest;
}
export function exportPart({ projectRoot = defaultRoot, outputDirectory, localOnly = false }) {
  const { policy, version } = releaseSource(projectRoot), identity = sourceIdentity(projectRoot, localOnly);
  const inventory = json(projectRoot, "licenses/rust-dependencies.json"), platform = platformForTarget(inventory.target);
  const selected = policy.platforms.find(item => item.platform === platform && item.target === inventory.target);
  const runtimePlatform = process.platform === "linux" ? "linux-" + process.arch + "-gnu" : process.platform + "-" + process.arch;
  if (!selected || runtimePlatform !== platform) throw new Error("Release binary must be tested on matching native architecture");
  const report = runPackagePreflight({ projectRoot, outputDirectory });
  const files = {};
  for (const file of [...packageKinds.map(kind => kind + ".tgz"), "preflight.json"]) files[file] = sha256(readNotice(outputDirectory, file));
  const part = { schemaVersion: 1, version, identity, target: selected.target, platform, files, packages: policy.packages };
  writeFileSync(join(outputDirectory, "part.json"), JSON.stringify(part, null, 2) + "\n");
  return { platform, version, identity, packedHostCases: report.packedHostCases };
}
function sameTree(a, b, excluded = []) {
  const files = treeFiles(a).filter(path => !excluded.some(prefix => path.startsWith(prefix)));
  const other = treeFiles(b).filter(path => !excluded.some(prefix => path.startsWith(prefix)));
  if (JSON.stringify(files) !== JSON.stringify(other) || files.some(path => !readNotice(a,path).equals(readNotice(b,path)))) throw new Error("Platform-dependent common package content");
}
export function mergePackageTrees({ projectRoot, inputs, outputDirectory, policy, version }) {
  const expected = policy.platforms.map(item => item.platform).sort();
  if (JSON.stringify(inputs.map(item => item.platform).sort()) !== JSON.stringify(expected)) throw new Error("Missing/duplicate release platform");
  for (const item of inputs) {
    const selected = policy.platforms.find(entry => entry.platform === item.platform && entry.target === item.target);
    if (!selected) throw new Error("Unapproved release target");
    for (const kind of packageKinds) {
      const base = item.packages[kind], pkg = json(base, "package.json"), wanted = json(join(projectRoot,"packages",kind),"package.json");
      if (JSON.stringify(pkg) !== JSON.stringify(wanted) || pkg.version !== version || pkg.name !== policy.packages[kind]) throw new Error("Mixed package metadata");
      verifyPackagedLicenses(base, kind, projectRoot);
      if (kind === "native") {
        const native = checkNative(base);
        const license = json(base, "licenses/distribution.json");
        if (Object.keys(native.artifacts).length !== 1 || !native.artifacts[item.platform] ||
            license.target !== item.target || license.platform !== item.platform) throw new Error("Part binary/license target mismatch");
      }
    }
  }
  const first = inputs[0].packages;
  for (const item of inputs.slice(1)) {
    sameTree(first.pi, item.packages.pi); sameTree(first.opencode, item.packages.opencode);
    sameTree(first.native, item.packages.native, ["native/", "licenses/"]);
  }
  newOutput(outputDirectory);
  for (const kind of ["pi","opencode"]) copyTree(first[kind], join(outputDirectory,kind));
  const native = join(outputDirectory,"native"); mkdirSync(native);
  for (const path of treeFiles(first.native).filter(path => !path.startsWith("native/")&&!path.startsWith("licenses/"))) {
    const file=join(native,path); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,readNotice(first.native,path),{flag:"wx"});
  }
  const manifest = { version, artifacts: {} }, targets=[];
  mkdirSync(join(native,"native"));
  mkdirSync(join(native,"licenses/pi-cursor"),{recursive:true});
  writeFileSync(join(native,"licenses/pi-cursor/LICENSE"),readNotice(projectRoot,"vendor/pi-cursor/LICENSE"));
  for (const item of [...inputs].sort((a,b)=>a.platform.localeCompare(b.platform))) {
    const entry = checkNative(item.packages.native).artifacts[item.platform];
    manifest.artifacts[item.platform]=entry;
    writeFileSync(join(native,"native",entry.file),readNotice(item.packages.native,"native/"+entry.file),{flag:"wx"});
    const directory="targets/"+item.platform;
    copyTree(join(item.packages.native,"licenses"),join(native,"licenses",directory));
    targets.push({platform:item.platform,target:item.target,directory});
  }
  writeFileSync(join(native,"native/manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  const licenseRoot=join(native,"licenses");
  const files=treeFiles(licenseRoot).map(path=>({path,sha256:sha256(readNotice(licenseRoot,path))}));
  const original=json(first.native,"licenses/distribution.json");
  writeFileSync(join(licenseRoot,"distribution.json"),JSON.stringify({
    generatedBy:original.generatedBy,version,projectLicenseSha256:original.projectLicenseSha256,
    upstreamLicenseSha256:original.upstreamLicenseSha256,targets,files
  },null,2)+"\n");
  verifyPackagedLicenses(native,"native",projectRoot); checkNative(native);
}
export function aggregateParts({ projectRoot = defaultRoot, inputDirectory, outputDirectory, localOnly = false }) {
  const { policy, version }=releaseSource(projectRoot), identity=sourceIdentity(projectRoot,localOnly);
  const temporary=mkdtempSync(join(tmpdir(),"cursor-release-aggregate-"));
  try {
    const dirs=readdirSync(inputDirectory,{withFileTypes:true});
    if(dirs.some(entry=>!entry.isDirectory()||entry.isSymbolicLink()))throw new Error("Unexpected release part input");
    const inputs=[];
    for(const dir of dirs){
      const base=join(inputDirectory,dir.name),part=json(base,"part.json");
      if(part.schemaVersion!==1||part.version!==version||JSON.stringify(part.packages)!==JSON.stringify(policy.packages))throw new Error("Incompatible release part");
      assertIdentity(part.identity,identity);
      if(JSON.stringify(Object.keys(part.files).sort())!==JSON.stringify(["native.tgz","opencode.tgz","pi.tgz","preflight.json"]))throw new Error("Unexpected release part file set");
      if(JSON.stringify(treeFiles(base))!==JSON.stringify(["native.tgz","opencode.tgz","part.json","pi.tgz","preflight.json"]))throw new Error("Extra release part files");
      for(const[file,hash]of Object.entries(part.files))if(!/^[a-f0-9]{64}$/.test(hash)||sha256(readNotice(base,file))!==hash)throw new Error("Release part checksum mismatch");
      const evidence=json(base,"preflight.json");
      if(!evidence.offlineInstall||!evidence.lifecycleScriptsDisabled||!evidence.isolatedTypeConsumer||
          evidence.nativeLoadWithoutToolchain!==version||evidence.packedHostCases!==6||
          !Array.isArray(evidence.packages)||evidence.packages.length!==3||
          packageKinds.some(kind=>evidence.packages.filter(pkg=>pkg.kind===kind&&pkg.name===policy.packages[kind]&&pkg.version===version).length!==1)||
          evidence.packages.find(pkg=>pkg.kind==="native")?.target!==part.target)throw new Error("Missing packed-host evidence");
      const packages={};
      for(const kind of packageKinds)packages[kind]=extractPackage(join(base,kind+".tgz"),join(temporary,dir.name+"-"+kind));
      inputs.push({platform:part.platform,target:part.target,packages});
    }
    const staged=join(temporary,"packages");
    mergePackageTrees({projectRoot,inputs,outputDirectory:staged,policy,version});
    const npm=isolatedNpm(join(temporary,"npm")),packed=[];
    // isolatedNpm creates its nested home; all artifacts stay outside the checkout.
    newOutput(outputDirectory);
    for(const kind of packageKinds){
      const result=JSON.parse(npm.run(["pack","--json","--pack-destination",temporary],join(staged,kind)))[0];
      if(result.name!==policy.packages[kind]||result.version!==version)throw new Error("Unexpected aggregated package");
      const file=kind+".tgz"; copyFileSync(join(temporary,result.filename),join(outputDirectory,file));
      packed.push({kind,name:result.name,file,sha256:sha256(readNotice(outputDirectory,file))});
    }
    const bundle={schemaVersion:1,version,identity,platforms:policy.platforms.map(item=>item.platform).sort(),packages:packed};
    writeFileSync(join(outputDirectory,"release-manifest.json"),JSON.stringify(bundle,null,2)+"\n");
    verifyBundle({projectRoot,bundleDirectory:outputDirectory,localOnly});
    return bundle;
  } finally {rmSync(temporary,{recursive:true,force:true});}
}
export function verifyBundle({projectRoot=defaultRoot,bundleDirectory,localOnly=false}){
  const{policy,version}=releaseSource(projectRoot),identity=sourceIdentity(projectRoot,localOnly);
  const bundle=json(bundleDirectory,"release-manifest.json");assertIdentity(bundle.identity,identity);
  if(bundle.schemaVersion!==1||bundle.version!==version||
      JSON.stringify(bundle.platforms)!==JSON.stringify(policy.platforms.map(item=>item.platform).sort())||
      bundle.packages.length!==3)throw new Error("Invalid release bundle coverage");
  const seen=new Set(),temporary=mkdtempSync(join(tmpdir(),"cursor-release-verify-"));
  try{
    for(const item of bundle.packages){
      if(!packageKinds.includes(item.kind)||seen.has(item.kind)||item.name!==policy.packages[item.kind]||item.file!==item.kind+".tgz"||
          !/^[a-f0-9]{64}$/.test(item.sha256)||sha256(readNotice(bundleDirectory,item.file))!==item.sha256)throw new Error("Invalid bundle package checksum/identity");
      seen.add(item.kind);
      const base=extractPackage(join(bundleDirectory,item.file),join(temporary,item.kind));
      if(JSON.stringify(json(base,"package.json"))!==JSON.stringify(json(join(projectRoot,"packages",item.kind),"package.json")))throw new Error("Bundle metadata differs from source");
      verifyPackagedLicenses(base,item.kind,projectRoot);
      if(item.kind==="native"){
        const manifest=checkNative(base);
        if(JSON.stringify(Object.keys(manifest.artifacts).sort())!==JSON.stringify(bundle.platforms))throw new Error("Bundle platform mismatch");
      }
    }
    if(JSON.stringify(treeFiles(bundleDirectory))!==JSON.stringify(["native.tgz","opencode.tgz","pi.tgz","release-manifest.json"]))throw new Error("Unexpected release bundle files");
  }finally{rmSync(temporary,{recursive:true,force:true});}
  return bundle;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const[command,...args]=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==="--local"){options.localOnly=true;continue;}
    const keys={"--input":"inputDirectory","--output":"outputDirectory","--bundle":"bundleDirectory"};
    if(!keys[args[i]]||!args[i+1])throw new Error("Unknown release preflight argument");
    options[keys[args[i]]]=resolve(args[++i]);
  }
  const fn={export:exportPart,aggregate:aggregateParts,verify:verifyBundle}[command];
  if(!fn)throw new Error("Only export/aggregate/verify preflight commands exist");
  console.log(JSON.stringify(fn(options),null,2));
}
