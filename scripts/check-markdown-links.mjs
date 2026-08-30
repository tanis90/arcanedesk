#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const output = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
);
const markdownFiles = output.split("\0").filter(file => file.endsWith(".md"));
const failures = [];

for (const file of markdownFiles) {
  const contents = readFileSync(resolve(repositoryRoot, file), "utf8");
  const links = contents.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g);
  for (const match of links) {
    const original = match[1]?.trim() ?? "";
    const target = original.replace(/^<|>$/g, "").split("#", 1)[0]?.trim() ?? "";
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      failures.push(`${file}: malformed link encoding: ${original}`);
      continue;
    }
    const absolute = resolve(repositoryRoot, dirname(file), decoded);
    if (!existsSync(absolute)) failures.push(`${file}: missing local link target: ${original}`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Markdown links verified in ${markdownFiles.length} files.\n`);
