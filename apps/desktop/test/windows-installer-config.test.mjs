import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows installer lets users choose an installation directory", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(desktopRoot, "package.json"), "utf8"),
  );

  assert.deepEqual(packageJson.build.nsis, {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    selectPerMachineByDefault: false,
  });
});
