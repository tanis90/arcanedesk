import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function replaceFile(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx");
    try { writeFileSync(fd, contents, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* No completed replacement. */ }
    throw error;
  }
}
