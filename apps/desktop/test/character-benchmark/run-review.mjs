import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{cases}=require('./cases.cjs'),{build,snapshot}=require('./runtime.cjs'),{verify}=require('./verify-v3.cjs');
const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const value=(k,d)=>process.argv.find(x=>x.startsWith('--'+k+'='))?.split('=').slice(1).join('=')||d;
const runId=value('run','character-review-20260909-v3'),out=value('out',path.join(os.tmpdir(),runId));fs.mkdirSync(out,{recursive:true});
const selected=cases.filter(c=>value('cases','A1,A2,A3,B1,B2,B3').split(',').includes(c.id));
function call(fn,arg,label){const script=path.join(out,label+'.js'),input=path.join(out,label+'-input.json');fs.writeFileSync(script,`return (${fn.toString()})(arg);`);fs.writeFileSync(input,JSON.stringify(arg));
 const text=execFileSync(process.execPath,[path.join(repo,'packages/fvtt-cli/dist/cli.js'),'--port',value('port','9230'),'--target-url','http://127.0.0.1:30000','debug-eval','--script','@'+script,'--arg','@'+input,'--timeout','60000'],{env:{...process.env,ARCANE_FVTT_DEBUG_EVAL:'1'},encoding:'utf8',timeout:75000,maxBuffer:32*1024*1024});const r=JSON.parse(text);if(!r.ok)throw Error('CLI call failed');return r.data;}
for(const plan of selected){const receiptPath=path.join(out,plan.id+'-receipt.json');let receipt;
 if(process.argv.includes('--verify-only')){receipt=JSON.parse(fs.readFileSync(receiptPath));}else {if(fs.existsSync(receiptPath))throw Error('Receipt exists. Use --verify-only, never replay creation.');receipt=call(build,{plan,runId,folderName:'Benchmark 审阅 · 职业成长 v3'},plan.id+'-create');fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2));}
 const [actual]=call(snapshot,{ids:[receipt.id],sourceUuid:plan.sourceUuid},plan.id+'-snapshot');fs.writeFileSync(path.join(out,plan.id+'-snapshot.json'),JSON.stringify(actual,null,2));
 const result=verify(plan,actual,receipt);fs.writeFileSync(path.join(out,plan.id+'-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({case:plan.id,id:receipt.id,core:result.corePass,configuration:result.configurationPass,failures:result.checks.filter(x=>!x.ok).map(x=>({id:x.id,expected:x.expected,observed:x.observed}))}));
}
console.log(JSON.stringify({reviewArtifacts:out}));

