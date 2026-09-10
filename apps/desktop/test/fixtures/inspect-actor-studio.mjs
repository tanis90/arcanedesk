import assert from "node:assert/strict";
const origin="http://127.0.0.1:30101",port=9231,world="cos-a";
const pages=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(p=>p.type==="page"&&p.url===`${origin}/game`);assert.equal(pages.length,1);
const ws=new WebSocket(pages[0].webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener("open",r,{once:true});ws.addEventListener("error",j,{once:true});});let n=0;const pending=new Map();ws.addEventListener("message",e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error||m.result?.exceptionDetails?p.reject(Error(JSON.stringify(m.error??m.result.exceptionDetails))):p.resolve(m.result?.result?.value);});
const ev=code=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>{pending.delete(id);reject(Error("timeout"));},60000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression:`(async()=>{if(location.origin!==${JSON.stringify(origin)}||game.world.id!==${JSON.stringify(world)}||!game.ready||!game.user.isGM)throw Error("guard");return await (${code});})()`,returnByValue:true,awaitPromise:true}}));});
const out=await ev(`(async()=>{
 const mods=Array.from(game.modules.values()).map(m=>({id:m.id,title:m.title,active:m.active,version:m.version,authors:m.authors,relationships:m.relationships,flags:m.flags}));
 const packs=Array.from(game.packs).map(p=>({collection:p.collection,title:p.title,documentName:p.documentName,packageName:p.metadata?.packageName,packageId:p.metadata?.id,flags:p.metadata?.flags}));
 const candidates=mods.filter(m=>/actor|studio|builder|character|车|角色/i.test([m.id,m.title,JSON.stringify(m.authors),JSON.stringify(m.flags)].join(' ')));
 const candidatePacks=packs.filter(p=>/actor|studio|builder|character|automation|dnd5e/i.test([p.collection,p.title,p.packageName,p.packageId,JSON.stringify(p.flags)].join(' ')));
 const packSamples=[];for(const p of game.packs){if(!/actor|studio|builder|character|automation|dnd5e/i.test(p.collection+p.title+p.metadata?.packageName))continue;try{const idx=await p.getIndex();packSamples.push({collection:p.collection,title:p.title,documentName:p.documentName,size:idx.size,sample:idx.contents.slice(0,5).map(e=>({id:e._id,name:e.name,type:e.type,identifier:e.system?.identifier,level:e.system?.level,source:e.system?.source}))});}catch(e){packSamples.push({collection:p.collection,error:String(e.message)})}}
 return {modules:mods,candidates,candidatePacks,packSamples};
})()`);
console.log(JSON.stringify(out,null,2));ws.close();
