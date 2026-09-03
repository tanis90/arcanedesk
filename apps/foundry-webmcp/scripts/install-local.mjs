import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(projectRoot, "dist");
const manifest = JSON.parse(
  await readFile(join(distDir, "module.json"), "utf8"),
);
const dataRoot = resolve(process.env.FVTT_DATA_PATH ?? "D:\\FVTT_DATA");
const modulesRoot = resolve(dataRoot, "Data", "modules");
const destination = resolve(modulesRoot, manifest.id);
const destinationRelative = relative(modulesRoot, destination);

if (
  basename(destination) !== "arcane-webmcp" ||
  destinationRelative.startsWith("..") ||
  destinationRelative === ""
) {
  throw new Error(`Refusing unsafe module destination: ${destination}`);
}

await stat(distDir);
await mkdir(modulesRoot, { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(distDir, destination, { recursive: true });

console.log(`Installed ${manifest.id} ${manifest.version} to ${destination}`);
