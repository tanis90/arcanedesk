import { err } from "./i18n-error.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate and canonicalize an explicit provider endpoint.
 *
 * Remote credentials may only travel over HTTPS. Plain HTTP remains available
 * for an LLM server running on the same machine, where TLS is commonly absent.
 */
export function validateProviderBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: true, baseUrl: "", origin: null };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: err("err.provider.baseUrlInvalid") };
  }

  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, error: err("err.provider.baseUrlInvalid") };
  }

  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopbackHttp) {
    return { ok: false, error: err("err.provider.baseUrlHttpsRequired") };
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return {
    ok: true,
    baseUrl: `${url.origin}${pathname}`,
    origin: url.origin,
  };
}

/**
 * The authority allowed to receive a provider credential. Explicit endpoints
 * bind to scheme + host + port; providers using an SDK default bind to API type.
 */
export function providerCredentialTarget({ api, baseUrl }) {
  const endpoint = validateProviderBaseUrl(baseUrl);
  if (!endpoint.ok) return endpoint;
  return {
    ...endpoint,
    target: endpoint.origin
      ? `origin:${endpoint.origin}`
      : `default-api:${String(api ?? "openai-completions")}`,
  };
}

