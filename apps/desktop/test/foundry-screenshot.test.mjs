import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  capturePageNavigationSafe,
  encodeFoundryScreenshot,
} from "../src/main/foundry-screenshot.js";

test("capturePageNavigationSafe returns a composed page image and removes listeners", async () => {
  const image = { id: "frame" };
  const captureCalls = [];
  const webContents = new EventEmitter();
  webContents.isDestroyed = () => false;
  webContents.getURL = () => "http://127.0.0.1:30000/game";
  webContents.capturePage = async (...args) => {
    captureCalls.push(args);
    return image;
  };

  const result = await capturePageNavigationSafe(webContents, { timeoutMs: 100 });

  assert.deepEqual(result, {
    status: "completed",
    image,
    url: "http://127.0.0.1:30000/game",
  });
  assert.deepEqual(captureCalls, [[undefined, { stayHidden: true, stayAwake: true }]]);
  assert.equal(webContents.listenerCount("did-start-navigation"), 0);
  assert.equal(webContents.listenerCount("destroyed"), 0);
});

test("capturePageNavigationSafe settles on main-frame navigation", async () => {
  const webContents = new EventEmitter();
  webContents.isDestroyed = () => false;
  webContents.capturePage = () => new Promise(() => {});

  const pending = capturePageNavigationSafe(webContents, { timeoutMs: 100 });
  webContents.emit("did-start-navigation", {}, "http://127.0.0.1:30000/join", false, true);

  assert.deepEqual(await pending, {
    status: "navigated",
    url: "http://127.0.0.1:30000/join",
  });
});

test("encodeFoundryScreenshot resizes the long edge and emits bounded JPEG metadata", () => {
  const resizeCalls = [];
  const resized = {
    getSize: () => ({ width: 1568, height: 784 }),
    toJPEG: (quality) => {
      assert.equal(quality, 82);
      return Buffer.from("jpeg-frame");
    },
  };
  const source = {
    isEmpty: () => false,
    getSize: () => ({ width: 2000, height: 1000 }),
    resize: (options) => {
      resizeCalls.push(options);
      return resized;
    },
  };

  const result = encodeFoundryScreenshot(source);

  assert.deepEqual(resizeCalls, [{ width: 1568, quality: "better" }]);
  assert.equal(result.data, Buffer.from("jpeg-frame").toString("base64"));
  assert.deepEqual(
    {
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      quality: result.quality,
    },
    {
      mimeType: "image/jpeg",
      width: 1568,
      height: 784,
      sourceWidth: 2000,
      sourceHeight: 1000,
      quality: 82,
    }
  );
});

test("encodeFoundryScreenshot lowers quality when the first JPEG exceeds the payload ceiling", () => {
  const qualities = [];
  const source = {
    isEmpty: () => false,
    getSize: () => ({ width: 800, height: 450 }),
    toJPEG: (quality) => {
      qualities.push(quality);
      return quality === 82 ? Buffer.alloc(1_500_001) : Buffer.from("smaller");
    },
  };

  const result = encodeFoundryScreenshot(source);

  assert.deepEqual(qualities, [82, 70]);
  assert.equal(result.quality, 70);
  assert.equal(result.bytes, Buffer.byteLength("smaller"));
});

test("encodeFoundryScreenshot rejects an empty GPU frame", () => {
  assert.throws(
    () => encodeFoundryScreenshot({ isEmpty: () => true }),
    /empty screenshot/
  );
});
