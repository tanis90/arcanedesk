import { randomUUID } from "node:crypto";

export const messageKey = message => message?.arcaneMessageKey ?? `${message?.role}:${message?.timestamp}`;

/** Attach identity before SDK message_end persistence; stream updates may be clones. */
export class MessageIdentity {
  constructor() { this.active = new Map(); }
  observe(event) {
    if (event.type === "agent_start") this.active.clear();
    const message = event.message;
    if (!["user", "assistant"].includes(message?.role)) return;
    if (!["message_start", "message_update", "message_end", "turn_end"].includes(event.type)) return;
    if (event.type === "message_start") {
      message.arcaneMessageKey ??= `message:${randomUUID()}`;
      this.active.set(message.role, message.arcaneMessageKey);
    } else {
      const key = message.arcaneMessageKey ?? this.active.get(message.role);
      if (key) message.arcaneMessageKey = key;
    }
  }
}
