import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";

function fixture() {
  const actors = Array.from({ length: 105 }, (_, index) => ({ id: String(index).padStart(3, "0"),
    uuid: `Actor.${String(index).padStart(3, "0")}`, name: "Guard", type: index % 2 ? "character" : "npc", system: { private: "not returned" } }));
  const pack = { collection: "example.monsters", documentName: "Actor", metadata: { packageName: "example" },
    getIndex: async () => [{ _id: "wolf", name: "Wolf", type: "npc" }, { _id: "bear", name: "Bear", type: "npc" }] };
  const game = { ready: true, user: { isGM: true }, actors, scenes: [{ id: "s", uuid: "Scene.s", name: "Town" }], packs: new Map([[pack.collection, pack]]) };
  const run = vm.runInNewContext(`(${runtimeFunction})`, { game });
  return { run: async args => JSON.parse(JSON.stringify(await run("contentSearch", args, {}))) };
}

test("world search returns bounded exact references without actor contents; cursor retrieves the remainder", async () => {
  const f = fixture(), query = { scope: "world", documentType: "Actor", query: "guard", limit: 100 };
  const first = await f.run(query), second = await f.run({ ...query, cursor: first.nextCursor });
  assert.equal(first.entries.length, 100); assert.equal(second.entries.length, 5); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(value => value.uuid)).size, 105);
  assert.equal(JSON.stringify(first).includes("not returned"), false);
  await assert.rejects(f.run({ ...query, query: "other", cursor: first.nextCursor }), /cursor/);
});

test("compendium search preserves package/pack/entry identity and filters type", async () => {
  const f = fixture();
  const result = await f.run({ scope: "compendium", documentType: "Actor", query: "Wolf", actorType: "npc", packIds: ["example.monsters"] });
  assert.deepEqual(result.entries[0], { uuid: "Compendium.example.monsters.Actor.wolf", id: "wolf", entryId: "wolf",
    name: "Wolf", type: "npc", documentType: "Actor", packId: "example.monsters", package: "example" });
  assert.equal(result.total, 1);
});

test("unsupported document combinations, mismatched packs and excessive limits reject", async () => {
  const f = fixture();
  await assert.rejects(f.run({ scope: "world", documentType: "Item", query: "" }), /INPUT_INVALID/);
  await assert.rejects(f.run({ scope: "compendium", documentType: "Scene", query: "" }), /INPUT_INVALID/);
  await assert.rejects(f.run({ scope: "compendium", documentType: "Item", query: "", packIds: ["example.monsters"] }), /PACK_NOT_FOUND/);
  await assert.rejects(f.run({ scope: "world", documentType: "Actor", query: "", limit: 101 }), /limit/);
});

test("Item search matches translated names by identifier, keeps type filters and bounded references", async () => {
  const requested=[];
  const pack={collection:'example.spells',documentName:'Item',metadata:{packageName:'example'},getIndex:async options=>{requested.push(options.fields);return [
    {_id:'a',name:'火球术',type:'spell',system:{identifier:'fireball',private:'not returned'}},
    {_id:'b',name:'魔法飞弹',type:'spell',system:{identifier:'magic-missile'}},
    {_id:'c',name:'火焰剑',type:'weapon',system:{identifier:'fireball-sword'}},
    {_id:'d',name:'无标识符',type:'spell'}];}};
  const run=vm.runInNewContext(`(${runtimeFunction})`,{game:{ready:true,user:{isGM:true},packs:new Map([[pack.collection,pack]])}});
  const query={scope:'compendium',documentType:'Item',query:'Fireball',itemType:'spell'};
  const first=JSON.parse(JSON.stringify(await run('contentSearch',query,{})));
  assert.equal(first.total,1);assert.equal(first.entries[0].name,'火球术');assert.equal(first.entries[0].uuid,'Compendium.example.spells.Item.a');
  assert.equal(JSON.stringify(first).includes('private'),false);assert.equal(requested[0].includes('system.identifier'),true);
  const spaced=await run('contentSearch',{...query,query:'Magic Missile'},{});assert.equal(spaced.total,1);
  const chinese=await run('contentSearch',{...query,query:'火球'},{});assert.equal(chinese.total,1);
  const punctuation=await run('contentSearch',{...query,query:'-'},{});assert.equal(punctuation.total,0);
});

test('batch search reads each index once, deduplicates identities, and separates missing names from later pages', async()=>{
  let reads=0;
  const pack={collection:'example.items',documentName:'Item',getIndex:async()=>{reads++;return [
    {_id:'a',name:'火球术',type:'spell',system:{identifier:'fireball'}},
    {_id:'b',name:'Magic Missile',type:'spell',system:{identifier:'magic-missile'}}];}};
  const run=vm.runInNewContext(`(${runtimeFunction})`,{game:{ready:true,user:{isGM:true},packs:new Map([[pack.collection,pack]])}});
  const input={scope:'compendium',documentType:'Item',query:['Fireball','火球','Magic Missile','Absent'],limit:1};
  const first=JSON.parse(JSON.stringify(await run('contentSearch',input,{})));
  assert.equal(reads,1);assert.equal(first.total,2);assert.deepEqual(first.entries[0].matchedQueries,['Fireball','火球']);
  assert.deepEqual(first.missingQueries,['Absent']);assert.ok(first.nextCursor);
  const second=JSON.parse(JSON.stringify(await run('contentSearch',{...input,cursor:first.nextCursor},{})));
  assert.equal(reads,2);assert.equal(second.entries[0].id,'b');assert.equal(second.nextCursor,null);
  await assert.rejects(run('contentSearch',{...input,query:[...input.query].reverse(),cursor:first.nextCursor},{}),/cursor/);
  for(const query of [[],[''],['Wolf','Wolf'],Array(17).fill('x'),['Wolf',null]]){
    await assert.rejects(run('contentSearch',{...input,query},{}),/INPUT_INVALID/);
  }
  assert.equal(reads,2,'Invalid batch must not load packs');
});
