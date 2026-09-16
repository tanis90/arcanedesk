import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { captureFoundryInputContext } from "../src/main/foundry-input-context.js";

test("fixed admission read captures world and selected UUIDs without exposing character data", async () => {
  const page = new EventEmitter();
  const state = vm.createContext({ location: { origin: "https://f.test" },
    game: { ready: true, user: { isGM: true }, world: { id: "w" } },
    canvas: { scene: { uuid: "Scene.s" }, tokens: { controlled: [{ document: { uuid: "Scene.s.Token.A", private: "omit" } }] } } });
  page.executeJavaScript = async expression => vm.runInContext(expression, state);
  const result = JSON.parse(JSON.stringify(await captureFoundryInputContext(page)));
  state.canvas.tokens.controlled = [{ document: { uuid: "Scene.s.Token.B" } }];
  assert.deepEqual(result, { world: { origin: "https://f.test", id: "w" }, sceneUuid: "Scene.s", selectedTokenUuids: ["Scene.s.Token.A"] });
  assert.equal(page.listenerCount("did-start-navigation"), 0);
});

test("no panel or unready world stores null instead of guessing a selection", async () => {
  assert.equal(await captureFoundryInputContext(null), null);
  const page = new EventEmitter();
  page.executeJavaScript = async expression => vm.runInNewContext(expression, { game: { ready: false } });
  assert.equal(await captureFoundryInputContext(page), null);
});

test("navigation during capture cannot bind identity from the old world", async () => {
  const page = new EventEmitter();
  page.executeJavaScript = async () => {
    page.emit("did-start-navigation", {}, "https://other.test/game", false, true);
    return { world: { origin: "https://old.test", id: "w" } };
  };
  assert.equal(await captureFoundryInputContext(page), null);
});
