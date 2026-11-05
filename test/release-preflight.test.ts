import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
// @ts-expect-error Development tooling is intentionally JavaScript.
import { preparePackageLicenses, sha256, verifyPackagedLicenses } from "../scripts/package-licenses.mjs";
// @ts-expect-error Development tooling is intentionally JavaScript.
import { aggregateParts, assertIdentity, mergePackageTrees, releaseSource, sourceIdentity, verifyBundle } from "../scripts/release.mjs";
// @ts-expect-error Development tooling is intentionally JavaScript.
import { copyTree, extractPackage, isolatedNpm } from "../scripts/pack-utils.mjs";

// @ts-expect-error Development tooling is intentionally JavaScript.
import { dependencyRecords, lockedSourceBinding } from "../scripts/license-inputs.mjs";

// A test double for VCS metadata only. No real repository is initialized or committed.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: (command: string, args: string[], options: object) => {
    if (command === "git") return args[0] === "rev-parse" ? "a".repeat(40) + "\n" : "";
    return actual.execFileSync(command, args, options);
  } };
});
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const base=mkdtempSync(join(tmpdir(),"cursor-release-test-"));temporary.push(base);
  const root=join(base,"source");
  const put=(path:string,data:string|object|Buffer)=>{
    const file=join(root,path);mkdirSync(dirname(file),{recursive:true});
    writeFileSync(file,typeof data==="string"||Buffer.isBuffer(data)?data:JSON.stringify(data));
  };
  const version="0.3.0",names={native:"@cursor-harness-provider/native",pi:"@cursor-harness-provider/pi",opencode:"@cursor-harness-provider/opencode"};
  const platforms=[{platform:"darwin-arm64",target:"aarch64-apple-darwin",runner:"macos-15"},{platform:"linux-x64-gnu",target:"x86_64-unknown-linux-gnu",runner:"ubuntu-22.04"}];
  const policy={schemaVersion:1,repository:"berialcheng/cursor-harness-provider",registry:"https://registry.npmjs.org/",packages:names,platforms};
  put("release.config.json",policy);put("package.json",{version,private:true,license:"MIT"});
  put("package-lock.json",{packages:{}});put("Cargo.lock","fixture lock");
  put("Cargo.toml",'[workspace.package]\nversion = "0.3.0"\n');
  put("crates/fixture/Cargo.toml", '[package]\nname = "fixture"\n');
  const dependency={name:"fixture-lib",version:"1.0.0",source:"registry+https://github.com/rust-lang/crates.io-index",license:"MIT",dependencyScope:"normal",notices:["rust/fixture-lib-1.0.0/LICENSE"]};
  put("licenses/locked-target-dependencies.json",{schemaVersion:1,sourceBinding:lockedSourceBinding(root),
    targets:Object.fromEntries(platforms.map(item=>[item.target,dependencyRecords([dependency]).map((dep: { name: string; version: string })=>({...dep,notices:[{path:dependency.notices[0],sha256:sha256(Buffer.from("MIT License\nDependency fixture\n"))}]}))]))});
  put("LICENSE","MIT License\nProject fixture\n");put("vendor/pi-cursor/LICENSE","MIT License\nUpstream fixture\n");
  put("licenses/upstream-notices.json",{});
  put("licenses/rust/fixture-lib-1.0.0/LICENSE","MIT License\nDependency fixture\n");
  for(const kind of ["native","pi","opencode"] as const){
    put("packages/"+kind+"/package.json",{name:names[kind],version,private:false,license:"MIT",
      repository:{type:"git",url:"git+https://github.com/berialcheng/cursor-harness-provider.git",directory:"packages/"+kind},
      publishConfig:{access:"public",registry:policy.registry},
      dependencies:kind==="native"?{}:{[names.native]:version}});
    put("packages/"+kind+"/THIRD_PARTY_NOTICES.md","Unchanged license at licenses/pi-cursor/LICENSE\n");
    put("packages/"+kind+"/dist/index.js","export const fixture=true;\n");
  }
  const inputs=[];
  for(const item of platforms){
    rmSync(join(root,"packages/native/native"),{recursive:true,force:true});
    const bytes=Buffer.from("native fixture "+item.platform),hash=sha256(bytes),file="cursor_native."+item.platform+"."+hash.slice(0,16)+".node";
    put("packages/native/native/"+file,bytes);
    put("packages/native/native/manifest.json",{version,artifacts:{[item.platform]:{file,sha256:hash}}});
    put("licenses/rust-dependencies.json",{target:item.target,dependencies:[dependency]});
    preparePackageLicenses(root);
    const packages:Record<string,string>={};
    for(const kind of ["native","pi","opencode"]){const destination=join(base,item.platform,kind);copyTree(join(root,"packages",kind),destination);packages[kind]=destination;}
    inputs.push({...item,packages});
  }
  return{base,root,put,inputs,policy,version,outputDirectory:join(base,"merged")};
}
function merge(f:ReturnType<typeof fixture>){mergePackageTrees({projectRoot:f.root,...f});}
describe("release preflight aggregation",()=>{
  it("merges binaries without flattening or dropping target-specific license inventories",()=>{
    const f=fixture();merge(f);
    const native=join(f.outputDirectory,"native"),manifest=JSON.parse(readFileSync(join(native,"native/manifest.json"),"utf8"));
    expect(Object.keys(manifest.artifacts).sort()).toEqual(["darwin-arm64","linux-x64-gnu"]);
    expect(verifyPackagedLicenses(native,"native",f.root).targets).toEqual(["aarch64-apple-darwin","x86_64-unknown-linux-gnu"]);
    for(const input of f.inputs)expect(existsSync(join(native,"licenses/targets",input.platform,"rust-dependencies.json"))).toBe(true);
  });
  it("packs, hashes and verifies a complete synthetic bundle offline",()=>{
    const f=fixture(),input=join(f.base,"parts"),output=join(f.base,"bundle");
    for(const name of ["CI","GITHUB_SHA","GITHUB_RUN_ID","GITHUB_RUN_ATTEMPT"])vi.stubEnv(name,undefined);
    try{
      const identity=sourceIdentity(f.root,true),npm=isolatedNpm(join(f.base,"npm-pack"));
      for(const item of f.inputs){
        const directory=join(input,item.platform);mkdirSync(directory,{recursive:true});
        for(const kind of ["native","pi","opencode"]){
          const result=JSON.parse(npm.run(["pack","--json","--pack-destination",directory],item.packages[kind]))[0];
          const bytes=readFileSync(join(directory,result.filename));
          rmSync(join(directory,result.filename));writeFileSync(join(directory,kind+".tgz"),bytes);
        }
        const evidence={offlineInstall:true,lifecycleScriptsDisabled:true,isolatedTypeConsumer:true,nativeLoadWithoutToolchain:f.version,packedHostCases:6,
          packages:["native","pi","opencode"].map(kind=>({kind,name:f.policy.packages[kind as keyof typeof f.policy.packages],version:f.version,...(kind==="native"?{target:item.target}:{})}))};
        writeFileSync(join(directory,"preflight.json"),JSON.stringify(evidence));
        const files=Object.fromEntries(["native.tgz","pi.tgz","opencode.tgz","preflight.json"].map(file=>[file,sha256(readFileSync(join(directory,file)))]));
        writeFileSync(join(directory,"part.json"),JSON.stringify({schemaVersion:1,version:f.version,identity,target:item.target,platform:item.platform,files,packages:f.policy.packages}));
      }
      const bundle=aggregateParts({projectRoot:f.root,inputDirectory:input,outputDirectory:output,localOnly:true});
      expect(bundle.platforms).toEqual(["darwin-arm64","linux-x64-gnu"]);
      expect(verifyBundle({projectRoot:f.root,bundleDirectory:output,localOnly:true}).packages).toHaveLength(3);
      writeFileSync(join(output,"pi.tgz"),"corrupted");
      expect(()=>verifyBundle({projectRoot:f.root,bundleDirectory:output,localOnly:true})).toThrow(/checksum\/identity/);
    }finally{vi.unstubAllEnvs();}
  // Several offline npm/Python subprocesses take longer on hosted Intel Macs.
  },90000);
  it("rejects missing and duplicate targets",()=>{
    const f=fixture();
    expect(()=>mergePackageTrees({projectRoot:f.root,...f,inputs:f.inputs.slice(0,1)})).toThrow(/Missing\/duplicate/);
    expect(()=>mergePackageTrees({projectRoot:f.root,...f,inputs:[f.inputs[0],f.inputs[0]]})).toThrow(/Missing\/duplicate/);
  });
  it("rejects a target triple that does not match the approved platform",()=>{
    const f=fixture();f.inputs[0].target="x86_64-apple-darwin";
    expect(()=>merge(f)).toThrow(/Unapproved release target/);
  });
  it("rejects platform-dependent native JS/declarations",()=>{
    const f=fixture();writeFileSync(join(f.inputs[1].packages.native,"dist/index.js"),"different");
    expect(()=>merge(f)).toThrow(/Platform-dependent common/);
  });
  it("rejects platform-dependent adapter files",()=>{
    const f=fixture();writeFileSync(join(f.inputs[1].packages.pi,"dist/index.js"),"different");
    expect(()=>merge(f)).toThrow(/Platform-dependent common/);
  });
  it("rejects package metadata drift between target builds",()=>{
    const f=fixture(),path=join(f.inputs[1].packages.opencode,"package.json"),p=JSON.parse(readFileSync(path,"utf8"));p.version="9.9.9";writeFileSync(path,JSON.stringify(p));
    expect(()=>merge(f)).toThrow(/Mixed package metadata/);
  });
  it("rejects a tampered native binary",()=>{
    const f=fixture(),base=f.inputs[0].packages.native,m=JSON.parse(readFileSync(join(base,"native/manifest.json"),"utf8"));
    writeFileSync(join(base,"native",m.artifacts["darwin-arm64"].file),"tampered");
    expect(()=>merge(f)).toThrow(/Native binary checksum/);
  });
  it("rejects an unmanifested native binary",()=>{
    const f=fixture();writeFileSync(join(f.inputs[0].packages.native,"native/unlisted.node"),"extra");
    expect(()=>merge(f)).toThrow(/Uninventoried native/);
  });
  it("rejects tampered per-target notices",()=>{
    const f=fixture();writeFileSync(join(f.inputs[0].packages.native,"licenses/rust/fixture-lib-1.0.0/LICENSE"),"changed");
    expect(()=>merge(f)).toThrow(/checksum mismatch/);
  });
  it("refuses to overwrite output directories",()=>{
    const f=fixture();mkdirSync(f.outputDirectory);writeFileSync(join(f.outputDirectory,"keep"),"owned");
    expect(()=>merge(f)).toThrow(/overwrite release output/);
    expect(readFileSync(join(f.outputDirectory,"keep"),"utf8")).toBe("owned");
  });
  it("does not accept mixed source commits, lockfiles, run ids or local-only evidence",()=>{
    const identity={commit:"a".repeat(40),npmLockSha256:"b".repeat(64),cargoLockSha256:"c".repeat(64),runId:"123",runAttempt:"1",localOnly:false};
    expect(()=>assertIdentity({...identity},identity)).not.toThrow();
    for(const change of [{commit:"d".repeat(40)},{npmLockSha256:"d".repeat(64)},{cargoLockSha256:"d".repeat(64)},{runId:"other"},{runAttempt:"2"},{localOnly:true}])
      expect(()=>assertIdentity({...identity,...change},identity)).toThrow(/Mixed release source/);
  });
  it("requires public package metadata but keeps the root private",()=>{
    const f=fixture();expect(releaseSource(f.root).version).toBe(f.version);
    const p=JSON.parse(readFileSync(join(f.root,"packages/pi/package.json"),"utf8"));p.private=true;f.put("packages/pi/package.json",p);
    expect(()=>releaseSource(f.root)).toThrow(/Unprepared release package/);
  });
  it("forbids non-public dependency lock sources",()=>{
    const f=fixture();f.put("package-lock.json",{packages:{fixture:{resolved:"https://example.invalid/private.tgz"}}});
    expect(()=>releaseSource(f.root)).toThrow(/Non-public npm lockfile/);
  });
});
describe("safe build-time tarball handling",()=>{
  function archive(name:string,type:string){
    const base=mkdtempSync(join(tmpdir(),"cursor-archive-test-"));temporary.push(base);
    const path=join(base,"fixture.tgz");
    execFileSync("python3",["-c","import tarfile,sys,io\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n m=tarfile.TarInfo(sys.argv[2]);m.size=4\n if sys.argv[3]=='link':m.type=tarfile.SYMTYPE;m.linkname='../../outside';m.size=0\n t.addfile(m,io.BytesIO(b'MIT\\n') if m.isfile() else None)",path,name,type]);
    return{base,path,destination:join(base,"extracted")};
  }
  it("rejects traversal paths before creating an extraction directory",()=>{
    const f=archive("package/../../outside","file");
    expect(()=>extractPackage(f.path,f.destination)).toThrow();
    expect(existsSync(f.destination)).toBe(false);
  });
  it("rejects symlinks before extracting anything",()=>{
    const f=archive("package/link","link");
    expect(()=>extractPackage(f.path,f.destination)).toThrow();
    expect(existsSync(f.destination)).toBe(false);
  });
  it("bounds PAX metadata before the tar parser consumes it",()=>{
    const f=archive("package/LICENSE","file");
    execFileSync("python3",["-c","import tarfile,sys,io\nwith tarfile.open(sys.argv[1],'w:gz',format=tarfile.PAX_FORMAT) as t:\n m=tarfile.TarInfo('package/LICENSE');m.size=4;m.pax_headers={'comment':'x'*8192}\n t.addfile(m,io.BytesIO(b'MIT\\n'))",f.path]);
    expect(()=>extractPackage(f.path,f.destination,{maxExpandedBytes:4096})).toThrow(/Expanded archive byte budget exceeded/);
    expect(existsSync(f.destination)).toBe(false);
  });
  it("does not allow callers to raise the hard expanded-byte ceiling",()=>{
    const f=archive("package/LICENSE","file");
    expect(()=>extractPackage(f.path,f.destination,{maxExpandedBytes:512*1024*1024})).toThrow(/Invalid expanded archive/);
  });
  it("retains legitimate nested license paths named src",()=>{
    const f=archive("package/licenses/rust/crate/src/spin/LICENSE","file"),base=extractPackage(f.path,f.destination);
    expect(readFileSync(join(base,"licenses/rust/crate/src/spin/LICENSE"),"utf8")).toBe("MIT\n");
  });
  it("offline helper refuses every command except pack/install",()=>{
    const base=mkdtempSync(join(tmpdir(),"cursor-npm-command-test-"));temporary.push(base);
    const npm=isolatedNpm(base,"unused-npm-cli");
    for(const command of ["publish","stage","login","access"])expect(()=>npm.run([command],base)).toThrow(/Only offline pack\/install/);
  });
});
describe("preflight and stage-only workflow policy",()=>{
  it("pins actions and gates merged-package tests without registry credentials",()=>{
    const root=fileURLToPath(new URL("../",import.meta.url)),text=readFileSync(join(root,".github/workflows/publish.yml"),"utf8"),w=YAML.parse(text);
    expect(w.permissions).toEqual({contents:"read"});
    expect(w.concurrency["cancel-in-progress"]).toBe(false);
    expect(w.on.workflow_dispatch.inputs.stage_npm.default).toBe(false);
    expect(w.on.workflow_dispatch).toBeDefined();expect(w.on.push.branches).toEqual(["main"]);expect(w.on.push.tags).toBeUndefined();
    expect(w.jobs.aggregate.needs).toBe("build");expect(w.jobs["verify-packed"].needs).toBe("aggregate");
    const policy=JSON.parse(readFileSync(join(root,"release.config.json"),"utf8"));
    for(const name of ["build","verify-packed"]){
      expect(w.jobs[name].strategy.matrix.include.map((i:{platform:string,target:string,os:string})=>({platform:i.platform,target:i.target,runner:i.os}))).toEqual(policy.platforms);
    }
    expect(w.jobs["stage-npm"].needs).toEqual(["build","aggregate","verify-packed"]);
    expect(w.jobs["stage-npm"].environment).toBe("npm-release");
    expect(w.jobs["stage-npm"].permissions).toEqual({contents:"read","id-token":"write"});
    expect(w.jobs["stage-npm"].if).toContain("inputs.stage_npm == true");
    expect(w.jobs["stage-npm"].if).toContain("refs/heads/main");
    for(const [name,job] of Object.entries(w.jobs) as Array<[string,{permissions?:object,steps:Array<{uses?:string,run?:string}>}]>){
      if(name!=="stage-npm")expect(job.permissions).toBeUndefined();
      for(const step of job.steps){if(step.uses)expect(step.uses).toMatch(/@[a-f0-9]{40}$/);if(step.run)expect(step.run).not.toMatch(/npm\s+(?:publish|stage|login)|NODE_AUTH_TOKEN|NPM_TOKEN|git\s+push/);}
    }
    expect(text).not.toMatch(/packages:\s*write|workflow_run:|secrets\./);
  });
});
