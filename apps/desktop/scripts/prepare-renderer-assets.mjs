#!/usr/bin/env node

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(desktopRoot, "generated", "renderer-assets");

function packageRoot(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

const assets = [
  ["marked", "lib/marked.umd.js"],
  ["@highlightjs/cdn-assets", "highlight.min.js"],
  ["@highlightjs/cdn-assets", "styles/nord.min.css"],
  ["@highlightjs/cdn-assets", "styles/stackoverflow-light.min.css"],
  ["katex", "dist/katex.min.js"],
  ["katex", "dist/katex.min.css"],
  ["mermaid", "dist/mermaid.min.js"],
];

await fs.rm(outputRoot, { recursive: true, force: true });
for (const [packageName, relative] of assets) {
  const source = path.join(packageRoot(packageName), ...relative.split("/"));
  const destination = path.join(outputRoot, packageName.replace("@", ""), ...relative.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

await fs.cp(
  path.join(packageRoot("katex"), "dist", "fonts"),
  path.join(outputRoot, "katex", "dist", "fonts"),
  { recursive: true },
);

process.stdout.write("Prepared renderer assets from workspace dependencies.\n");
