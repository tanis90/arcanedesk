#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

export async function writeSha256Sums(outputFile, inputFiles) {
  if (!outputFile) throw new Error("output file is required");
  if (!inputFiles.length) throw new Error("at least one input file is required");

  const sortedFiles = [...inputFiles].sort((left, right) =>
    path.basename(left).localeCompare(path.basename(right), "en"),
  );
  const lines = [];
  for (const file of sortedFiles) {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error(`not a file: ${file}`);
    lines.push(`${await sha256File(file)}  ${path.basename(file)}`);
  }
  await fsp.writeFile(outputFile, `${lines.join("\n")}\n`, "utf8");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const [, , outputFile, ...inputFiles] = process.argv;
  await writeSha256Sums(outputFile, inputFiles);
}
