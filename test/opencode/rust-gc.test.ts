import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeBindingPath } from "@cursor-native/native";
const run = promisify(execFile);
describe("Rust Node-API rejected-promise lifetime", () => {
  it("does not strongly retain failed async method receivers", async () => {
    const code = `
      const {createRequire}=await import('node:module');
      const {createServer}=await import('node:http2');
      const {once}=await import('node:events');
      const binding=createRequire(import.meta.url)(process.argv[1]);
      if(binding.nativeVersion()!=='0.3.0')throw new Error('Expected the shared 0.3.0 native artifact');
      const refs=[];
      const server=createServer();
      const sessions=new Set();
      server.on('session',s=>{sessions.add(s);s.on('close',()=>sessions.delete(s));});
      server.on('stream',s=>{s.on('error',()=>{});s.respond({':status':200,'content-type':'application/connect+proto'});});
      server.listen(0,'127.0.0.1'); await once(server,'listening');
      const url='http://127.0.0.1:'+server.address().port;
      try {
        for(const mode of ['start','remove','listModels']){
          let e=new binding.NativeEngine();
          refs.push(new WeakRef(e));
          let failed=false;
          try {
            if(mode==='start')await e.start('{}','fixture');
            else if(mode==='remove')await e.remove('invalid');
            else await e.listModels('',url);
          }catch{failed=true;}
          if(!failed)throw new Error('Expected rejected native method');
          e.shutdown();e=undefined;
        }
        let owner=new binding.NativeEngine();
        let stream=await owner.start(JSON.stringify({scope:'a'.repeat(64),modelId:'auto',workspace:'/tmp',prompt:[{role:'user',content:[{type:'text',text:'hold'}]}],stateless:true,agentUrl:url,maxRetries:0}),'fixture');
        refs.push(new WeakRef(stream));
        let rejected=false;try{await stream.setAccessToken('fixture-replacement')}catch{rejected=true;}
        if(!rejected)throw new Error('Unexpected refresh acceptance');
        stream.cancel();stream=undefined;
        owner.shutdown();owner=undefined;
        let alive=refs.length;
        for(let attempt=0;attempt<100;attempt++){
          await new Promise(setImmediate);global.gc();await new Promise(setImmediate);
          alive=refs.filter(ref=>ref.deref()!==undefined).length;if(!alive)break;
        }
        process.stdout.write(JSON.stringify({alive,receivers:refs.length}));
      } finally {for(const s of sessions)s.destroy();await new Promise(r=>server.close(r));}
    `;
    const result = await run(process.execPath, ["--expose-gc", "--input-type=module", "-e", code, nativeBindingPath()], {
      timeout: 15000, maxBuffer: 1024 * 1024,
    });
    expect(JSON.parse(result.stdout)).toEqual({ alive: 0, receivers: 4 });
  }, 20000);
});
