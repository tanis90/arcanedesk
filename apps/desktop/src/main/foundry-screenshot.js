const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;
const MAX_SCREENSHOT_BYTES = 1_500_000;
const BACKGROUND_CAPTURE_OPTIONS = {
  stayHidden: true,
  stayAwake: true,
};

const ENCODE_PASSES = [
  { maxDimension: 1568, quality: 82 },
  { maxDimension: 1568, quality: 70 },
  { maxDimension: 1280, quality: 76 },
  { maxDimension: 1024, quality: 68 },
];

function errorMessage(error) {
  return error?.message ?? String(error);
}

/**
 * Capture the composed pixels of the current Foundry viewport without letting
 * a reload, destroyed renderer or stalled GPU surface leave the tool pending.
 * Electron keeps the hidden page hidden while servicing the capture and keeps
 * its renderer awake for the duration of the request.
 * @param {any} webContents
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export function capturePageNavigationSafe(
  webContents,
  { timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS, signal } = /** @type {{ timeoutMs?: number, signal?: AbortSignal }} */ ({})
) {
  if (!webContents || webContents.isDestroyed?.()) {
    return Promise.resolve({ status: "error", error: "Foundry panel is not available" });
  }
  if (typeof webContents.capturePage !== "function") {
    return Promise.resolve({ status: "error", error: "Foundry panel cannot capture its viewport" });
  }
  if (signal?.aborted) return Promise.resolve({ status: "aborted" });

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      webContents.off?.("did-start-navigation", onNavigation);
      webContents.off?.("destroyed", onDestroyed);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const onNavigation = (_event, url, isInPlace, isMainFrame) => {
      if (isMainFrame === false || isInPlace) return;
      finish({ status: "navigated", url });
    };
    const onDestroyed = () => finish({ status: "error", error: "Foundry panel was closed" });
    const onAbort = () => finish({ status: "aborted" });

    webContents.on?.("did-start-navigation", onNavigation);
    webContents.on?.("destroyed", onDestroyed);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish({ status: "timeout", timeoutMs }), timeoutMs);

    // Keep both handlers attached immediately: navigation may win while the
    // underlying capture promise later rejects as its old surface disappears.
    Promise.resolve()
      .then(() => webContents.capturePage(undefined, BACKGROUND_CAPTURE_OPTIONS))
      .then(
        (image) => finish({ status: "completed", image, url: webContents.getURL?.() ?? "" }),
        (error) => finish({ status: "error", error: errorMessage(error) })
      );
  });
}

function resizeToFit(image, maxDimension) {
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= maxDimension) return image;
  return width >= height
    ? image.resize({ width: maxDimension, quality: "better" })
    : image.resize({ height: maxDimension, quality: "better" });
}

/**
 * Bound screenshot dimensions and encoded size before adding it to the model
 * transcript. JPEG suits Foundry's texture-heavy canvas and keeps one tool call
 * under the same rough payload ceiling as a normal Desktop image attachment.
 * @param {any} sourceImage Electron NativeImage-compatible object
 */
export function encodeFoundryScreenshot(sourceImage) {
  if (!sourceImage || sourceImage.isEmpty?.()) {
    throw new Error("Foundry returned an empty screenshot while background capture was active");
  }
  const sourceSize = sourceImage.getSize?.();
  if (!sourceSize || sourceSize.width <= 0 || sourceSize.height <= 0) {
    throw new Error("Foundry returned a screenshot with invalid dimensions");
  }

  for (const pass of ENCODE_PASSES) {
    const image = resizeToFit(sourceImage, pass.maxDimension);
    const bytes = image.toJPEG(pass.quality);
    if (!bytes?.length) continue;
    if (bytes.length <= MAX_SCREENSHOT_BYTES) {
      const size = image.getSize();
      return {
        data: bytes.toString("base64"),
        mimeType: "image/jpeg",
        width: size.width,
        height: size.height,
        sourceWidth: sourceSize.width,
        sourceHeight: sourceSize.height,
        bytes: bytes.length,
        quality: pass.quality,
      };
    }
  }

  throw new Error("Foundry screenshot remained too large after bounded compression");
}
