import { readFileSync, renameSync, unlinkSync } from "node:fs";
import { replaceFile } from "../atomic-file.js";

const consumed = input => ["consumed", "handled"].includes(input.state);
const validInput = input => input && typeof input.id === "string" && typeof input.commandId === "string"
  && typeof input.text === "string" && (!input.images || (Array.isArray(input.images)
    && input.images.every(image => typeof image.data === "string" && typeof image.mimeType === "string")));

/** Only input bodies awaiting consumption survive a restart. No executable task state. */
export class PendingInputs {
  constructor(file = null) {
    this.file = file;
    this.inputs = [];
    this.warning = null;
    if (!file) return;
    let text;
    try { text = readFileSync(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    try {
      const inputs = JSON.parse(text);
      if (!Array.isArray(inputs) || !inputs.every(validInput)) throw new Error("Invalid pending inputs");
      this.inputs = inputs;
    } catch {
      renameSync(file, `${file}.${Date.now()}.damaged`);
      this.warning = "Pending input data was damaged and has been set aside. Check the conversation before resending.";
    }
  }

  save(inputs) {
    const copy = inputs.filter(input => !consumed(input)).map(({ id, commandId, text, images, messageKey }) =>
      ({ id, commandId, text, images, messageKey }));
    if (this.file) replaceFile(this.file, JSON.stringify(copy));
    this.inputs = structuredClone(copy);
  }

  /** One-time extraction; old commands and answers are deliberately not restored. */
  migrate(file, saveModel) {
    let text;
    try { text = readFileSync(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const inputs = new Map();
    let model = null, damaged = false;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === "checkpoint") {
          if (!Array.isArray(record.inputs) || !record.inputs.every(validInput)) throw new Error("Invalid checkpoint inputs");
          inputs.clear();
          for (const input of record.inputs) inputs.set(input.id, input);
          model = record.pendingModel;
        } else if (record.type === "accepted") {
          if (!validInput(record.input)) throw new Error("Invalid accepted input");
          inputs.set(record.input.id, record.input);
        } else if (record.type === "input_state") {
          const input = inputs.get(record.inputId);
          if (input) input.state = record.state;
        } else if (record.type === "pending_model") model = record.model;
      } catch { damaged = true; break; }
    }
    // Preserve a newer replacement if a previous migration stopped before unlink.
    const merged = new Map([...inputs.values()].filter(input => !consumed(input)).map(input => [input.id, input]));
    for (const input of this.inputs) merged.set(input.id, input);
    this.save([...merged.values()]);
    if (model && typeof model.providerId === "string" && typeof model.modelId === "string") saveModel(model);
    if (damaged) {
      renameSync(file, `${file}.${Date.now()}.damaged`);
      this.warning = "Old pending input data was damaged. Recovered readable inputs; check the conversation before resending.";
    } else unlinkSync(file);
  }
}
