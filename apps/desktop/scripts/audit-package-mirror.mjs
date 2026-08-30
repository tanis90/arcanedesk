#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const DEFAULT_INDEX_URL = "https://arcane-package.oss-cn-beijing.aliyuncs.com/index.json";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ZIP_TAIL_BYTES = 65_557;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function responseBuffer(response, label, maxBytes = MAX_JSON_BYTES) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return buffer;
}

async function fetchJsonDocument(url, label) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "accept-encoding": "identity" },
  });
  const buffer = await responseBuffer(response, label);
  return {
    value: JSON.parse(buffer.toString("utf8")),
    bytes: buffer.length,
    sha256: sha256(buffer),
  };
}

async function fetchRange(url, start, end, label) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "accept-encoding": "identity",
      Range: `bytes=${start}-${end}`,
    },
  });
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`${label} does not support bounded byte ranges: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function findEocd(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

function centralEntries(buffer, expectedCount) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`ZIP central directory signature mismatch at ${offset}`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({
      name,
      method: buffer.readUInt16LE(offset + 10),
      compressedBytes: buffer.readUInt32LE(offset + 20),
      uncompressedBytes: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length !== expectedCount) {
    throw new Error(`ZIP central directory expected ${expectedCount} entries; found ${entries.length}`);
  }
  return entries;
}

async function readArchiveManifest(entry, archiveBytes) {
  const tailStart = Math.max(0, archiveBytes - ZIP_TAIL_BYTES);
  const tail = await fetchRange(entry.zipUrl, tailStart, archiveBytes - 1, `${entry.id} ZIP tail`);
  const eocd = findEocd(tail);
  const count = tail.readUInt16LE(eocd + 10);
  const centralBytes = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if ([count, centralBytes, centralOffset].includes(0xffff) || centralOffset === 0xffffffff) {
    throw new Error(`${entry.id} ZIP64 central directory is not supported by the audit`);
  }
  const relativeCentral = centralOffset - tailStart;
  const central = relativeCentral >= 0 && relativeCentral + centralBytes <= tail.length
    ? tail.subarray(relativeCentral, relativeCentral + centralBytes)
    : await fetchRange(entry.zipUrl, centralOffset, centralOffset + centralBytes - 1, `${entry.id} ZIP directory`);
  const manifestName = entry.group === "system" ? "system.json" : "module.json";
  const candidates = centralEntries(central, count).filter((item) =>
    item.name === manifestName || new RegExp(`^[^/]+/${manifestName.replace(".", "\\.")}$`).test(item.name));
  const rootCandidate = candidates.find((item) => item.name === manifestName);
  const installableCandidates = rootCandidate ? [rootCandidate] : candidates;
  if (installableCandidates.length !== 1) {
    throw new Error(
      `${entry.id} ZIP contains ${installableCandidates.length} installable ${manifestName} candidates: ` +
      candidates.map((item) => item.name).join(", "),
    );
  }
  const candidate = installableCandidates[0];
  const localHeader = await fetchRange(
    entry.zipUrl,
    candidate.localOffset,
    candidate.localOffset + 29,
    `${entry.id} ZIP local header`,
  );
  if (localHeader.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.id} ZIP local header is invalid`);
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const payloadStart = candidate.localOffset + 30 + nameLength + extraLength;
  const compressed = await fetchRange(
    entry.zipUrl,
    payloadStart,
    payloadStart + candidate.compressedBytes - 1,
    `${entry.id} archived manifest`,
  );
  const payload = candidate.method === 0
    ? compressed
    : candidate.method === 8
      ? inflateRawSync(compressed)
      : null;
  if (!payload) throw new Error(`${entry.id} archived manifest uses unsupported ZIP method ${candidate.method}`);
  if (payload.length !== candidate.uncompressedBytes || payload.length > MAX_JSON_BYTES) {
    throw new Error(`${entry.id} archived manifest has an invalid uncompressed size`);
  }
  return JSON.parse(payload.toString("utf8"));
}

async function auditEntry(entry) {
  const hardProblems = [];
  const metadataDrift = [];
  try {
    const head = await fetch(entry.zipUrl, {
      method: "HEAD",
      cache: "no-store",
      headers: { "accept-encoding": "identity" },
    });
    const archiveBytes = Number(head.headers.get("content-length"));
    if (!head.ok) hardProblems.push(`ZIP returned HTTP ${head.status}`);
    if (archiveBytes !== entry.bytes) hardProblems.push(`ZIP bytes ${archiveBytes}, index ${entry.bytes}`);
    const [external, archived] = await Promise.all([
      fetchJsonDocument(entry.manifestUrl, `${entry.id} external manifest`),
      readArchiveManifest(entry, archiveBytes),
    ]);
    for (const [label, manifest] of [["external", external.value], ["archive", archived]]) {
      if (manifest.id !== entry.id) hardProblems.push(`${label} id ${manifest.id ?? "(none)"}`);
      if (String(manifest.version) !== String(entry.version)) {
        hardProblems.push(`${label} version ${manifest.version ?? "(none)"}`);
      }
    }
    if (external.value.manifest !== entry.manifestUrl) {
      hardProblems.push(`external manifest self URL ${external.value.manifest ?? "(none)"}`);
    }
    if (external.value.download !== entry.zipUrl) {
      hardProblems.push(`external download URL ${external.value.download ?? "(none)"}`);
    }
    if (archived.manifest && archived.manifest !== entry.manifestUrl) {
      metadataDrift.push({ field: "manifest", archived: archived.manifest, normalized: entry.manifestUrl });
    }
    if (archived.download && archived.download !== entry.zipUrl) {
      metadataDrift.push({ field: "download", archived: archived.download, normalized: entry.zipUrl });
    }
    return {
      id: entry.id,
      version: String(entry.version),
      manifestBytes: external.bytes,
      manifestSha256: external.sha256,
      hardProblems,
      metadataDrift,
    };
  } catch (error) {
    hardProblems.push(error instanceof Error ? error.message : String(error));
    return { id: entry.id, version: String(entry.version), hardProblems, metadataDrift };
  }
}

async function mapLimit(values, limit, callback) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await callback(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

export async function auditPackageMirror(indexUrl = DEFAULT_INDEX_URL) {
  const index = (await fetchJsonDocument(indexUrl, "mirror index")).value;
  if (!Array.isArray(index.packages)) throw new Error("mirror index has no packages array");
  const packages = await mapLimit(index.packages, 6, auditEntry);
  return {
    indexUrl,
    generated: index.generated ?? null,
    packageCount: packages.length,
    hardProblemCount: packages.filter((entry) => entry.hardProblems.length > 0).length,
    metadataDriftCount: packages.filter((entry) => entry.metadataDrift.length > 0).length,
    packages,
  };
}

async function main() {
  const indexUrl = process.argv[2] ?? DEFAULT_INDEX_URL;
  const report = await auditPackageMirror(indexUrl);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.hardProblemCount > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
