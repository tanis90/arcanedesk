// Independent world-state acceptance. No model completion text is trusted.
module.exports = function createVerifier(evaluate, imageHash) {
  return async(id,f)=>evaluate(`(async()=>{
    const f=${JSON.stringify(f)},kind=${JSON.stringify(id)};const a=game.actors.get(f.actorIds[0]),s=game.scenes.get(f.sceneId);let ok=false,details={};
    if(kind==="create_npc"){const found=game.actors.filter(a=>a.name===f.newName);details={count:found.length,prototype:found[0]?.prototypeToken.name,source:found[0]?._stats?.compendiumSource??found[0]?.flags.arcanedesk?.sourceUuid??null,hp:found[0]?.system.attributes.hp.max,hasBite:!!found[0]?.items.some(i=>i.name==="Bite")};ok=found.length===1&&details.prototype===f.newName&&details.hp===11&&details.hasBite;}
    if(kind==="grant_items"){const r=a.items.filter(i=>/Rapier/.test(i.name)),b=a.items.filter(i=>/Longbow/.test(i.name));details={rapiers:r.length,bows:b.length,rapierEquipped:r[0]?.system.equipped,bowEquipped:b[0]?.system.equipped,bowQuantity:b[0]?.system.quantity};ok=r.length===1&&b.length===1&&details.rapierEquipped===false&&details.bowEquipped===true&&details.bowQuantity===1;}
    if(kind==="edit_image"){const t=s.tokens.find(t=>t.actorId===a.id);details={name:a.name,hp:a.system.attributes.hp,ac:a.system.attributes.ac.value,img:a.img,prototype:a.prototypeToken.texture.src,token:t.toObject()};ok=a.name===f.label+" 队长"&&details.hp.value===8&&details.hp.max===18&&details.ac===14&&a.img==="systems/dnd5e/tokens/beast/Wolf.webp"&&a.prototypeToken.texture.src===a.img&&t.texture.src===a.img&&t.name===f.label+" Token1"&&t.x===200&&t.y===200&&t.width===1&&t.height===1;details.token={name:t.name,x:t.x,y:t.y,width:t.width,height:t.height,img:t.toObject().texture.src};}
    if(kind==="scene_layout"){details={tokens:s.tokens.map(t=>({name:t.name,x:t.x,y:t.y,actorId:t.actorId})),active:s.active,current:canvas.scene.id};const expected=[[f.label+" Token1",300,400,f.actorIds[0]],[f.label+" Token2",500,400,f.actorIds[1]],["新守卫A",700,400,f.actorIds[0]],["新守卫B",900,400,f.actorIds[0]]];ok=s.tokens.size===4&&expected.every(([n,x,y,a])=>s.tokens.some(t=>t.name===n&&t.x===x&&t.y===y&&t.actorId===a))&&!s.active&&canvas.scene.id===f.originalSceneId;}
    if(kind==="conditions"){details=f.actorIds.map(id=>({id,statuses:[...game.actors.get(id).statuses]}));ok=details.slice(0,2).every(a=>a.statuses.includes("prone")&&a.statuses.includes("poisoned"))&&!details[2].statuses.includes("prone")&&!details[2].statuses.includes("poisoned");}
    if(kind==="upload_image"){
      const img=a.img, token=s.tokens.find(t=>t.actorId===a.id);let hash=null,loadable=false,imageError=null;
      if(img&&!/^(?:data:|file:|https?:|[A-Za-z]:)/i.test(img)&&!img.includes("..")){
        try {
        const url=new URL(img,location.origin+"/");if(url.origin!==location.origin)throw Error("Image origin mismatch");
        const response=await fetch(url,{cache:"no-store"});
        if(response.ok){const blob=await response.blob();hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer()))).map(b=>b.toString(16).padStart(2,"0")).join("");const bitmap=await createImageBitmap(blob);loadable=bitmap.width===231&&bitmap.height===223;bitmap.close();}
        } catch(error) { imageError=error.name+": "+error.message; }
      }
      const untouched=f.actorIds.slice(1).every(id=>{const other=game.actors.get(id);return other.img===other.prototypeToken.texture.src&&other.img==="systems/dnd5e/icons/svg/actors/npc.svg";})&&s.tokens.filter(t=>t.actorId!==a.id).every(t=>t.texture.src==="systems/dnd5e/icons/svg/actors/npc.svg");
      ok=hash===${JSON.stringify(imageHash)}&&loadable&&a.prototypeToken.texture.src===img&&token.texture.src===img&&token.name===f.label+" Token1"&&token.x===200&&token.y===200&&token.width===1&&token.height===1&&untouched;
      details={imagePath:img,hash,loadable,untouched,imageError};
    }
    if(kind==="conditions"){
      const protectedIntact=f.protectedEffects.every(e=>{const actual=game.actors.get(e.actorId)?.effects.get(e.effectId);return actual?.name===e.name&&actual.disabled===false;});
      const uniqueStatuses=f.actorIds.slice(0,2).every(id=>["prone","poisoned"].every(status=>game.actors.get(id).effects.filter(e=>e.statuses.has(status)).length===1));
      ok=ok&&protectedIntact&&uniqueStatuses;details={actors:details,protectedIntact,uniqueStatuses};
    }
    return {ok,details};})()`);
};
