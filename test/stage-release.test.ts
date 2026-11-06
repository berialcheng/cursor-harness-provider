import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error Build tooling is intentionally JavaScript.
import { stageRelease, parseStageArgs } from "../scripts/stage-release.mjs";
// @ts-expect-error Build tooling is intentionally JavaScript.
import { sha256 } from "../scripts/package-licenses.mjs";
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"cursor-stage-test-"));temporary.push(directory);
  const names={native:"@cursor-harness-provider/native",pi:"@cursor-harness-provider/pi",opencode:"@cursor-harness-provider/opencode"};
  const identity={commit:"a".repeat(40),runId:"123",runAttempt:"1",localOnly:false};
  const packages=Object.entries(names).map(([kind,name])=>{const file=kind+".tgz",bytes=Buffer.from(kind);writeFileSync(join(directory,file),bytes);return{kind,name,file,sha256:sha256(bytes)};});
  const env={STAGE_NPM:"true",GITHUB_ACTIONS:"true",GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_REF:"refs/heads/main",GITHUB_REPOSITORY:"berialcheng/cursor-harness-provider",GITHUB_WORKFLOW_REF:"berialcheng/cursor-harness-provider/.github/workflows/publish.yml@refs/heads/main",GITHUB_SHA:identity.commit,GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",RUNNER_TEMP:directory,ACTIONS_ID_TOKEN_REQUEST_URL:"synthetic-present",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"synthetic-present"};
  const options={bundleDirectory:directory,version:"0.3.0",npmCli:join(directory,"npm-cli.js"),env};
  const verify=vi.fn(()=>({version:"0.3.0",identity,packages}));
  const source=vi.fn(()=>({version:"0.3.0",policy:{repository:env.GITHUB_REPOSITORY,packages:names}}));
  const execute=vi.fn((_binary:string,args:string[]):string=>args[1]==="--version"?"11.21.0\n":"staged\n");
  return{directory,env,options,verify,source,execute,identity,packages};
}
describe("OIDC stage-only release",()=>{
  it("verifies first and stages exactly native then Pi then OpenCode without approval",()=>{
    const f=fixture(),result=stageRelease(f.options,f);
    expect(result.outcome).toBe("pending-human-approval");
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls.slice(1).map(call=>call[1].slice(1,4))).toEqual(["native","pi","opencode"].map(kind=>["stage","publish",join(f.directory,kind+".tgz")]));
    expect(JSON.stringify(result)).not.toContain("synthetic-present");
    expect(f.execute.mock.invocationCallOrder[0]).toBeGreaterThan(f.verify.mock.invocationCallOrder[0]);
  });
  it("loads distinct empty configs with the real provisioned npm CLI without network/auth",()=>{
    const f=fixture(),cli=process.env.npm_execpath;
    if(!cli)throw Error("Run tests through npm to select the existing CLI");
    let checked=false;
    f.execute.mockImplementation((binary,args):string=>{
      if(args[1]==="--version"){
        expect(args[args.indexOf("--userconfig")+1]).not.toBe(args[args.indexOf("--globalconfig")+1]);
        const output=execFileSync(binary,[cli,...args.slice(1)],{cwd:f.directory,encoding:"utf8",env:{HOME:f.directory,PATH:dirname(process.execPath)+":/usr/bin:/bin"},timeout:10000});
        expect(output.trim()).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+$/);checked=true;return"11.21.0";
      }
      return"synthetic staged";
    });
    stageRelease(f.options,f);expect(checked).toBe(true);
  });
  it("refuses non-dispatch, non-main and missing OIDC before any upload",()=>{
    for(const change of [{GITHUB_EVENT_NAME:"push"},{GITHUB_REF:"refs/heads/feature"},{STAGE_NPM:"false"},{GITHUB_REPOSITORY:"other/repository"}]){
      const f=fixture();Object.assign(f.env,change);expect(()=>stageRelease(f.options,f)).toThrow();expect(f.execute).not.toHaveBeenCalled();
    }
    const f=fixture();delete (f.env as Partial<typeof f.env>).ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    expect(()=>stageRelease(f.options,f)).toThrow(/OIDC/);expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects legacy token/config overrides and a wrong version",()=>{
    for(const change of [{NPM_TOKEN:"synthetic"},{NODE_AUTH_TOKEN:""},{npm_config_registry:"https://example.invalid/"}]){
      const f=fixture();Object.assign(f.env,change);expect(()=>stageRelease(f.options,f)).toThrow(/overrides/);expect(f.execute).not.toHaveBeenCalled();
    }
    const f=fixture();f.options.version="0.4.0";expect(()=>stageRelease(f.options,f)).toThrow(/version/);
  });
  it("refuses failed verification, a foreign run or mutated archive before upload",()=>{
    const a=fixture();a.verify.mockImplementation(()=>{throw Error("synthetic corruption");});expect(()=>stageRelease(a.options,a)).toThrow(/verification/);expect(a.execute).not.toHaveBeenCalled();
    const b=fixture();b.identity.runId="124";expect(()=>stageRelease(b.options,b)).toThrow(/current release/);expect(b.execute).not.toHaveBeenCalled();
    const c=fixture();writeFileSync(join(c.directory,"native.tgz"),"changed");expect(()=>stageRelease(c.options,c)).toThrow(/changed/);expect(c.execute).toHaveBeenCalledTimes(1);
  });
  it("stops without retries or following packages after an uncertain upload",()=>{
    const f=fixture();f.execute.mockImplementation((_binary,args)=>{if(args[1]==="--version")return"11.21.0";throw Error("synthetic private child output");});
    expect(()=>stageRelease(f.options,f)).toThrow(/uncertain/);expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("parses only the three explicit staging arguments",()=>{
    expect(parseStageArgs(["--bundle","/tmp/bundle","--version","0.3.0","--npm-cli","/tmp/cli"])).toEqual({bundleDirectory:"/tmp/bundle",version:"0.3.0",npmCli:"/tmp/cli"});
    expect(()=>parseStageArgs(["--publish","true"])).toThrow();
  });
});
