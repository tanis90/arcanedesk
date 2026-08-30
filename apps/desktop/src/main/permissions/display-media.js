import { randomUUID } from "node:crypto";

function exactOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** User-gesture-gated screen/window selection for getDisplayMedia(). */
export class DisplayMediaController {
  constructor({
    desktopCapturer,
    getFoundryWebContents,
    getFoundryOrigin,
    sendToRenderer,
    platform = process.platform,
    requestTimeoutMs = 120_000,
    idFactory = () => `display_${randomUUID()}`,
    log = console.log,
  }) {
    this.desktopCapturer = desktopCapturer;
    this.getFoundryWebContents = getFoundryWebContents;
    this.getFoundryOrigin = getFoundryOrigin;
    this.sendToRenderer = sendToRenderer;
    this.platform = platform;
    this.requestTimeoutMs = requestTimeoutMs;
    this.idFactory = idFactory;
    this.log = log;
    this.pending = new Map();
  }

  trustedRequest(request) {
    const webContents = this.getFoundryWebContents();
    const expectedOrigin = exactOrigin(this.getFoundryOrigin());
    const frame = request?.frame;
    if (!webContents || webContents.isDestroyed?.() || !expectedOrigin || !frame || frame.isDestroyed?.()) return null;
    if (request.userGesture !== true || request.videoRequested !== true) return null;
    if (frame.parent !== null) return null;
    if (frame.frameTreeNodeId !== webContents.mainFrame?.frameTreeNodeId) return null;
    if (exactOrigin(request.securityOrigin) !== expectedOrigin || exactOrigin(frame.origin) !== expectedOrigin) return null;
    return { webContents, origin: expectedOrigin };
  }

  async handle(request, callback) {
    const trusted = this.trustedRequest(request);
    if (!trusted) {
      callback({});
      return;
    }

    // Only one chooser can be meaningfully acted on at a time. Cancel an older one
    // instead of allowing a remote page to stack picker overlays.
    this.cancelAll("superseded");
    let sources;
    try {
      sources = await this.desktopCapturer.getSources({
        types: ["window", "screen"],
        thumbnailSize: { width: 280, height: 158 },
        fetchWindowIcons: true,
      });
    } catch (error) {
      this.log(`[permissions] could not enumerate display sources: ${error.message}`);
      callback({});
      return;
    }
    if (!this.trustedRequest(request) || sources.length === 0) {
      callback({});
      return;
    }

    const requestId = this.idFactory();
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const pending = {
      requestId,
      callback,
      sourceById,
      audioAvailable: this.platform === "win32" && request.audioRequested === true,
      timer: null,
    };
    pending.timer = setTimeout(() => this.finish(pending, {}, "timeout"), this.requestTimeoutMs);
    this.pending.set(requestId, pending);

    try {
      this.sendToRenderer({
        type: "display_source_request",
        requestId,
        origin: trusted.origin,
        audioAvailable: pending.audioAvailable,
        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          kind: source.id.startsWith("screen:") ? "screen" : "window",
          thumbnail: source.thumbnail?.isEmpty?.() ? "" : source.thumbnail?.toDataURL?.() ?? "",
          appIcon: source.appIcon?.isEmpty?.() ? "" : source.appIcon?.toDataURL?.() ?? "",
        })),
      });
    } catch (error) {
      this.log(`[permissions] failed to show display source picker: ${error.message}`);
      this.finish(pending, {}, "renderer-unavailable");
    }
  }

  respond(requestId, sourceId, includeAudio) {
    const pending = this.pending.get(String(requestId ?? ""));
    if (!pending) return { ok: false, error: "display request expired" };
    if (!sourceId) {
      this.finish(pending, {}, "user-cancel");
      return { ok: true, granted: false };
    }
    const source = pending.sourceById.get(String(sourceId));
    if (!source) return { ok: false, error: "invalid display source" };
    const streams = { video: source };
    if (pending.audioAvailable && includeAudio === true) streams.audio = "loopback";
    this.finish(pending, streams, "user");
    return { ok: true, granted: true };
  }

  finish(pending, streams, reason) {
    if (!this.pending.has(pending.requestId)) return;
    clearTimeout(pending.timer);
    this.pending.delete(pending.requestId);
    try {
      pending.callback(streams);
    } catch {
      /* Requesting frame disappeared. */
    }
    try {
      this.sendToRenderer({ type: "display_source_resolved", requestId: pending.requestId, reason });
    } catch {
      /* Chat renderer is already gone. */
    }
  }

  cancelAll(reason = "navigation") {
    for (const pending of [...this.pending.values()]) this.finish(pending, {}, reason);
  }
}

/** Explicitly cancel device selection paths that bypass ordinary permissions. */
export function installDevicePermissionDenials(electronSession) {
  electronSession.setDevicePermissionHandler(() => false);
  electronSession.on("select-hid-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  electronSession.on("select-serial-port", (event, _ports, _webContents, callback) => {
    event.preventDefault();
    callback("");
  });
  electronSession.on("select-usb-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
}
