import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import createVerifier from "./fixtures/prep-benchmark-verifier.cjs";

test("undecodable upload is a failed trial instead of aborting the suite", async () => {
  const actor = { id: "a", img: "bad.jpg", prototypeToken: { texture: { src: "bad.jpg" } } };
  const token = { actorId: "a", texture: { src: "bad.jpg" }, name: "test Token1", x: 200, y: 200, width: 1, height: 1 };
  const context = vm.createContext({
    game: { actors: new Map([["a", actor]]), scenes: new Map([["s", { tokens: [token] }]]) },
    location: { origin: "http://127.0.0.1:30000" }, URL,
    fetch: async () => ({ ok: true, blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }),
    crypto: { subtle: { digest: async () => new Uint8Array([1]).buffer } },
    createImageBitmap: async () => { throw new DOMException("The source image could not be decoded.", "InvalidStateError"); }
  });
  const verify = createVerifier(code => vm.runInContext(code, context), "01");
  const result = await verify("upload_image", { actorIds: ["a"], sceneId: "s", label: "test" });
  assert.equal(result.ok, false);
  assert.equal(result.details.loadable, false);
  assert.match(result.details.imageError, /InvalidStateError/);
});

function fixture() {
  const actors = new Map();
  const ids = ["a", "b", "c"];
  for (const id of ids) {
    const effects = new Map([["sentinel", { name: "Unrelated", disabled: false, statuses: new Set() }]]);
    effects.filter = predicate => [...effects.values()].filter(predicate);
    const statuses = new Set(id === "c" ? [] : ["prone", "poisoned"]);
    for (const status of statuses) effects.set(status, { name: status, statuses: new Set([status]) });
    actors.set(id, { effects, statuses });
  }
  const context = vm.createContext({ game: { actors, scenes: new Map([["scene", {}]]) } });
  const verify = createVerifier(code => vm.runInContext(code, context), "unused");
  const data = { actorIds: ids, sceneId: "scene", protectedEffects: ids.map(actorId => ({ actorId, effectId: "sentinel", name: "Unrelated" })) };
  return { actors, run: () => verify("conditions", data) };
}

test("benchmark accepts exact conditions with unrelated effects preserved", async () => {
  const f = fixture(); assert.equal((await f.run()).ok, true);
});
test("benchmark rejects deleting an unrelated effect even when final statuses match", async () => {
  const f = fixture(); f.actors.get("a").effects.delete("sentinel");
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.details.protectedIntact, false);
});
test("benchmark rejects duplicate status effects even when final statuses match", async () => {
  const f = fixture(); f.actors.get("a").effects.set("duplicate", { statuses: new Set(["prone"]) });
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.details.uniqueStatuses, false);
});
test("benchmark rejects affecting the excluded third actor", async () => {
  const f = fixture(); f.actors.get("c").statuses.add("poisoned");
  assert.equal((await f.run()).ok, false);
});

function contentSkillFixture() {
  const image = "systems/dnd5e/icons/svg/actors/npc.svg";
  const actor = {
    id: "a", name: "test 队长", img: image,
    prototypeToken: { texture: { src: image } },
    system: { attributes: { hp: { value: 8, max: 18 }, ac: { value: 14 } } },
  };
  const scene = { tokens: [{ actorId: "a", name: "test Token1", x: 200, y: 200, width: 1, height: 1, texture: { src: image } }] };
  const journals = new Map();
  journals.filter = predicate => [...journals.values()].filter(predicate);
  const context = vm.createContext({
    game: { actors: new Map([["a", actor]]), scenes: new Map([["s", scene]]), journal: journals },
    location: { origin: "http://127.0.0.1:30000" }, URL,
    fetch: async () => ({ ok: true, blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }),
    crypto: { subtle: { digest: async () => new Uint8Array([1]).buffer } },
    createImageBitmap: async () => ({ width: 231, height: 223, close() {} }),
  });
  const verify = createVerifier(code => vm.runInContext(code, context), "01");
  const data = { actorIds: ["a"], sceneId: "s", label: "test", journalId: "existing" };
  const addJournal = (id, name, ownership, pages) => {
    const journal = { id, name, ownership: { default: ownership }, pages: { contents: pages } };
    journals.set(id, journal);
    return journal;
  };
  return { actor, scene, journals, verify, data, addJournal };
}

test("benchmark requires ordinary Actor edits to preserve every image", async () => {
  const f = contentSkillFixture();
  assert.equal((await f.verify("edit_preserves_images", f.data)).ok, true);
  f.actor.prototypeToken.texture.src = "changed.webp";
  assert.equal((await f.verify("edit_preserves_images", f.data)).ok, false);
});

test("benchmark accepts private HTML Journal creation", async () => {
  const f = contentSkillFixture();
  f.addJournal("new", "test 调查记录", 0, [{
    name: "第一次调查", type: "text",
    text: { content: "<h2>线索</h2><ul><li>发现暗门</li><li>暗门通往地下室</li></ul>" },
  }]);
  assert.equal((await f.verify("journal_create", f.data)).ok, true);
});

test("benchmark requires player handout ownership and HTML", async () => {
  const f = contentSkillFixture();
  const journal = f.addJournal("new", "test 玩家手记", 2, [{
    name: "补给", type: "text", text: { content: "<h2>补给</h2><ul><li>火把</li><li>绳索</li></ul>" },
  }]);
  assert.equal((await f.verify("journal_handout", f.data)).ok, true);
  journal.ownership.default = 0;
  assert.equal((await f.verify("journal_handout", f.data)).ok, false);
});

test("benchmark accepts an appended Journal page with the original preserved", async () => {
  const f = contentSkillFixture();
  f.addJournal("existing", "test 既有日志", 0, [
    { name: "原始记录", type: "text", text: { content: "<p>原始事实</p>" } },
    { name: "补充线索", type: "text", text: { content: "<ul><li>银色钥匙</li><li>潮湿脚印</li></ul>" } },
  ]);
  assert.equal((await f.verify("journal_append", f.data)).ok, true);
});

test("benchmark rejects an append that rewrites the original Journal page", async () => {
  const f = contentSkillFixture();
  f.addJournal("existing", "test 既有日志", 0, [
    { name: "原始记录", type: "text", text: { content: "<p>被改写</p>" } },
    { name: "补充线索", type: "text", text: { content: "<ul><li>银色钥匙</li><li>潮湿脚印</li></ul>" } },
  ]);
  assert.equal((await f.verify("journal_append", f.data)).ok, false);
});

test("benchmark limits a portrait-only request to the Actor image", async () => {
  const f = contentSkillFixture();
  f.actor.img = "arcanedesk/assets/portrait.jpg";
  assert.equal((await f.verify("portrait_only", f.data)).ok, true);
  f.scene.tokens[0].texture.src = f.actor.img;
  assert.equal((await f.verify("portrait_only", f.data)).ok, false);
});
