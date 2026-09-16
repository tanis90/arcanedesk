// Read-only COS probe for the content-catalog design. No writes and no model calls.
import assert from "node:assert/strict";
const origin="http://127.0.0.1:30101", port=9231, worldId="cos-a";
const pages=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(p=>p.type==="page"&&p.url===`${origin}/game`);
assert.equal(pages.length,1,"exactly one COS game page required");
const ws=new WebSocket(pages[0].webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener("open",r,{once:true});ws.addEventListener("error",j,{once:true});});
let seq=0;const pending=new Map();ws.addEventListener("message",e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error||m.result?.exceptionDetails)p.reject(Error(JSON.stringify(m.error??m.result.exceptionDetails)));else p.resolve(m.result?.result?.value);});
const evalPage=code=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error("CDP timeout"));},60000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression:`(async()=>{if(location.origin!==${JSON.stringify(origin)}||game.world.id!==${JSON.stringify(worldId)}||!game.ready||!game.user.isGM)throw Error("COS guard");return await (${code});})()`,returnByValue:true,awaitPromise:true}}));});
const result=await evalPage(`(async()=>{
  const packs=Array.from(game.packs).filter(p=>p.documentName==="Item");
  const pick=(name,rx)=>packs.filter(p=>rx.test(p.collection)).flatMap(p=>p.index.contents.filter(e=>e.name.toLowerCase().includes(name.toLowerCase())).map(e=>({uuid:\`Compendium.\${p.collection}.Item.\${e._id}\`,name:e.name,type:e.type,identifier:e.system?.identifier,fields:Object.keys(e.system||{}),source:e.system?.source}))).slice(0,20);
  const spells=packs.filter(p=>p.collection.includes("spells")).flatMap(p=>p.index.contents.filter(e=>e.type==="spell"&&/昼明|daylight|火球|fireball/i.test(e.name)).map(e=>({name:e.name,level:e.system?.level,source:e.system?.source,flags:e.flags,systemKeys:Object.keys(e.system||{}),uuid:\`Compendium.\${p.collection}.Item.\${e._id}\`})));
  const sample=packs.filter(p=>p.collection.includes("spells")).flatMap(p=>p.index.contents.filter(e=>e.type==="spell").slice(0,2).map(e=>({name:e.name,system:e.system,flags:e.flags,pack:p.collection})));
  const classDocs=[];for(const p of packs.filter(p=>p.collection.includes("classes")&&!p.collection.includes("classes24"))){for(const e of p.index.contents.filter(e=>/wizard|法师/i.test(e.name)).slice(0,2)){const d=await p.getDocument(e._id);classDocs.push({name:d.name,system:d.system,flags:d.flags,pack:p.collection});}}
  return {packNames:packs.map(p=>p.collection).filter(x=>/spell|class|item|weapon|armor/i.test(x)).slice(0,80),spells,sample,classes:classDocs,weapon:pick("长棍",/weapon/i)};
})()`);
console.log(JSON.stringify(result,null,2));ws.close();
