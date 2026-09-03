import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(projectRoot, "..", "..");
const distDir = join(projectRoot, "dist");
const packageJson = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
const moduleManifest = JSON.parse(
  await readFile(join(projectRoot, "module.template.json"), "utf8"),
);

if (moduleManifest.version !== packageJson.version) {
  throw new Error(
    `Version mismatch: package.json=${packageJson.version}, module.template.json=${moduleManifest.version}`,
  );
}

await rm(distDir, { recursive: true, force: true });
await mkdir(join(distDir, "scripts"), { recursive: true });

await build({
  entryPoints: [join(projectRoot, "src", "module.js")],
  outfile: join(distDir, "scripts", "arcane-webmcp.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  legalComments: "eof",
});

await writeFile(
  join(distDir, "module.json"),
  `${JSON.stringify(moduleManifest, null, 2)}\n`,
  "utf8",
);
await cp(join(repositoryRoot, "LICENSE"), join(distDir, "LICENSE"));
await cp(join(projectRoot, "NOTICE"), join(distDir, "NOTICE"));

console.log(`Built ${moduleManifest.id} ${moduleManifest.version} at ${distDir}`);
