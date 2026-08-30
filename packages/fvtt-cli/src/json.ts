import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";

export async function parseJsonInput(input: string | undefined): Promise<unknown> {
  const raw = input ?? "{}";
  let text: string;
  if (raw === "@-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    text = raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw;
  }
  text = text.replace(/^\uFEFF/, "");

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError("ERR_INVALID_JSON", "Input is not valid JSON", {
      input: raw.startsWith("@") ? raw : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function redactJsonSecrets(value: unknown, secrets: Iterable<string>): unknown {
  const sensitiveValues = Array.from(secrets).filter(secret => secret.length > 0);
  if (sensitiveValues.length === 0) return value;

  const redactText = (text: string): string =>
    sensitiveValues.reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      text
    );

  const visit = (current: unknown, key?: string): unknown => {
    if (typeof current === "string") {
      return key === "code" ? current : redactText(current);
    }
    if (Array.isArray(current)) return current.map(item => visit(item));
    if (!current || typeof current !== "object") return current;

    return Object.fromEntries(
      Object.entries(current).map(([nestedKey, nested]) => [
        nestedKey,
        visit(nested, nestedKey),
      ])
    );
  };

  return visit(value);
}
