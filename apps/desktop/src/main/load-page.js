// Retry only transient navigation failures, never page scripts or agent tools.
const retryable = new Set([
  "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_TIMED_OUT", "ERR_TIMED_OUT", "ERR_NETWORK_CHANGED",
  "ERR_INTERNET_DISCONNECTED", "ERR_NAME_NOT_RESOLVED",
]);

export async function loadPageWithRetry(webContents, url) {
  try {
    await webContents.loadURL(url);
  } catch (error) {
    if (webContents.isDestroyed() || !retryable.has(error.code)) throw error;
    await webContents.loadURL(url);
  }
}
