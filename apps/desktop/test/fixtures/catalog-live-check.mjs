import {createRequire} from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const {createTools}=require('./prep-content-catalog.cjs');
const {cases}=require('../character-benchmark/cases.cjs');
const origin=process.env.CATALOG_ORIGIN ?? 'http://127.0.0.1:30002';
const endpoint=process.env.CATALOG_CDP ?? 'http://127.0.0.1:9230';
const targets=await (await fetch(endpoint+'/json/list')).json();
let target=targets.find(t=>t.url===origin+'/game'||t.url===origin+'/join');
if(!target) target=await (await fetch(endpoint+'/json/new?'+encodeURIComponent(origin+'/join'),{method:'PUT'})).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
let sequence=0;const pending=new Map();
ws.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;
 pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
const send=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'));},60000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
try {
 let ready=false;
 for(let i=0;i<30;i++){ready=await evaluate('!!globalThis.game?.ready');if(ready)break;await new Promise(r=>setTimeout(r,1000));}
 const identity=await evaluate('({world:game.world?.id,ready:game.ready,isGM:game.user?.isGM,url:location.href})');
 if(identity.world!=='COS')throw Error('Expected local COS: '+JSON.stringify(identity));
 if(!identity.isGM){
   if(!process.argv.includes('--login'))throw Error('GM login required; pass --login to use the authorized empty Gamemaster password');
   const result=await evaluate(`(async()=>{const user=game.users.find(u=>u.name==='Gamemaster');if(!user)throw Error('Gamemaster missing');const r=await fetch('/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'join',userid:user.id,password:''})});return {status:r.status,result:await r.json()};})()`);
   if(result.status!==200)throw Error('Login failed: '+JSON.stringify(result));
   await send('Page.navigate',{url:origin+'/game'});
   for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,1000));if(await evaluate('!!globalThis.game?.ready && !!game.user?.isGM'))break;}
 }
 const environment=await evaluate(`({world:game.world.id,system:game.system.version,rules:game.settings.get('dnd5e','rulesVersion'),registryReady:game.dnd5e.registry.spellLists.ready})`);
 if(environment.world!=='COS'||environment.rules!=='legacy')throw Error('Environment mismatch: '+JSON.stringify(environment));
 const tools=createTools(expression=>evaluate(`(async()=>{if(game.world.id!=='COS'||!game.user.isGM)throw Error('COS GM required');return await (${expression});})()`));
 const records=[];
 for(const c of cases){
   const operations=[['list',{scope:'compendium',type:'classFeature',class:c.cls,subclass:c.subclass,characterLevel:c.level,rules:'2014',pageSize:100}]];
   if(c.sourceUuid)operations.unshift(['detail',{scope:'compendium',uuid:c.sourceUuid}]);
   if(c.slots.length)operations.push(['list',{scope:'compendium',type:'spell',class:c.cls,subclass:c.subclass,characterLevel:c.level,rules:'2014',pageSize:100}]);
   if(c.cls==='wizard')operations.push(['list',{scope:'compendium',type:'spell',class:c.cls,characterLevel:c.level,rules:'2014',query:'fireball'}]);
   if(c.id==='A1')operations.push(['list',{scope:'compendium',type:'weapon',query:'长棍'}]);
   if(c.id==='A3')operations.push(['list',{scope:'compendium',type:'weapon',query:'轻锤'}]);
   for(const [mode,input] of operations){const start=Date.now();let output,error;
     try{const result=await tools.find(t=>t.name.endsWith('_'+mode)).execute('check',input);output=JSON.parse(result.content[0].text);}catch(e){error=e.message;}
     records.push({case:c.id,mode,input,elapsedMs:Date.now()-start,output,error});
     console.log(JSON.stringify({case:c.id,mode,type:input.type,total:output?.total,error}));
   }
 }
 const path=process.env.CATALOG_OUTPUT;
 if(path)fs.writeFileSync(path,JSON.stringify({environment,records},null,2));
 else console.log(JSON.stringify({environment,records}));
}finally{ws.close();}
