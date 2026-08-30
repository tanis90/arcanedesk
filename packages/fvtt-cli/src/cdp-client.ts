import { CliError } from "./errors.js";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpEndpoint {
  host: string;
  port: number;
}

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type CdpEventListener = (params: unknown) => void;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export async function listTargets(
  endpoint: CdpEndpoint,
  timeoutMs?: number
): Promise<CdpTarget[]> {
  const url = `http://${endpoint.host}:${endpoint.port}/json/list`;
  let response: Response;

  try {
    response = await fetch(
      url,
      timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) }
        : undefined
    );
  } catch (error) {
    throw new CliError(
      "ERR_CDP_UNREACHABLE",
      `Cannot reach Chrome DevTools endpoint at ${url}`,
      stringifyCause(error)
    );
  }

  if (!response.ok) {
    throw new CliError("ERR_CDP_HTTP", `Chrome DevTools endpoint returned ${response.status}`, {
      url,
      status: response.status,
      statusText: response.statusText,
    });
  }

  const targets = (await response.json()) as unknown;
  if (!Array.isArray(targets)) {
    throw new CliError("ERR_CDP_BAD_TARGET_LIST", "Chrome DevTools target list is not an array");
  }

  return targets.map(target => normalizeTarget(target)).filter(Boolean) as CdpTarget[];
}

function normalizeTarget(target: unknown): CdpTarget | null {
  if (!target || typeof target !== "object") return null;
  const record = target as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.type !== "string") return null;

  return {
    id: record.id,
    type: record.type,
    title: typeof record.title === "string" ? record.title : "",
    url: typeof record.url === "string" ? record.url : "",
    ...(typeof record.webSocketDebuggerUrl === "string"
      ? { webSocketDebuggerUrl: record.webSocketDebuggerUrl }
      : {}),
  };
}

export class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventListeners = new Map<string, Set<CdpEventListener>>();
  private receiveChain: Promise<void> = Promise.resolve();
  private ws?: WebSocket;

  constructor(private readonly wsUrl: string) {}

  async connect(timeoutMs = 10000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new CliError("ERR_CDP_CONNECT_TIMEOUT", `Timed out connecting to ${this.wsUrl}`));
        try {
          ws.close();
        } catch {
          // Ignore close failures during timeout cleanup.
        }
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new CliError("ERR_CDP_CONNECT", `Failed to connect to ${this.wsUrl}`));
      };

      ws.onmessage = event => {
        this.receiveChain = this.receiveChain
          .then(() => this.handleMessage(event.data))
          .catch(error => {
            this.rejectAll(error instanceof Error ? error : new Error(String(error)));
          });
      };

      ws.onclose = () => {
        this.rejectAll(new CliError("ERR_CDP_DISCONNECTED", "Chrome DevTools session closed"));
      };
    });
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new CliError("ERR_CDP_NOT_CONNECTED", "Chrome DevTools session is not connected");
    }

    const id = this.nextId++;
    const request: CdpRequest = { id, method, params };

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError("ERR_CDP_COMMAND_TIMEOUT", `CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeout,
      });
    });

    ws.send(JSON.stringify(request));
    return promise;
  }

  on(method: string, listener: CdpEventListener): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set<CdpEventListener>();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(method);
    };
  }

  close(): void {
    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      this.ws.close();
    }
    this.rejectAll(new CliError("ERR_CDP_CLOSED", "Chrome DevTools session closed"));
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const text = typeof raw === "string" ? raw : await blobLikeToText(raw);
    const message = JSON.parse(text) as CdpResponse;
    if (typeof message.id !== "number") {
      if (typeof message.method === "string") {
        for (const listener of this.eventListeners.get(message.method) ?? []) {
          try {
            listener(message.params);
          } catch {
            // An observer must not break CDP command-response processing.
          }
        }
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(
        new CliError("ERR_CDP_COMMAND", message.error.message, {
          code: message.error.code,
          data: message.error.data,
        })
      );
      return;
    }

    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function blobLikeToText(raw: unknown): Promise<string> {
  if (raw instanceof Blob) return raw.text();
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(raw);
  }
  return String(raw);
}

function stringifyCause(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
}
