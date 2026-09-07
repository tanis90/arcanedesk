import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync } from "node:fs";
import path from "node:path";

/** Durable command acceptance. A damaged tail is truncated, never replayed as work. */
export class InputJournal {
  constructor(file = null) {
    this.file = file;
    this.records = [];
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) return;
    const bytes = readFileSync(file);
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) break;
      try { this.records.push(JSON.parse(bytes.subarray(offset, end).toString("utf8"))); }
      catch { throw new Error("Invalid task journal record; refusing to discard committed history"); }
      offset = end + 1;
    }
    if (offset < bytes.length) truncateSync(file, offset);
  }

  append(record) {
    const copy = structuredClone(record);
    if (this.file) {
      const fd = openSync(this.file, "a");
      try { appendFileSync(fd, JSON.stringify(copy) + "\n", "utf8"); fsyncSync(fd); }
      finally { closeSync(fd); }
    }
    this.records.push(copy);
  }
}
