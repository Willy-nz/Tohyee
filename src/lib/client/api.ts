"use client";

export class ApiError extends Error {
  readonly status: number;
  /** The server's error code (e.g. "dashboard_conflict"), when it sent one. */
  readonly code: string | null;
  /** Extra facts the server sent with the error, when it sent any. */
  readonly details: Record<string, unknown> | null;

  constructor(message: string, status: number, code: string | null = null, details: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorFields(payload: unknown): { code: string | null; details: Record<string, unknown> | null } {
  if (!payload || typeof payload !== "object") return { code: null, details: null };
  const record = payload as Record<string, unknown>;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details) ? (record.details as Record<string, unknown>) : null;
  return { code: typeof record.code === "string" ? record.code : null, details };
}

export type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
};
type Options = ApiOptions;

/**
 * Another way to the API for a page that isn't signed in with a session:
 * the PowerPoint add-in (#429, decision 838) sends Analytics' reads to the
 * Analytics API for Office with its own token, and refuses everything else.
 */
export type ApiTransport = (path: string, options: ApiOptions) => Promise<unknown>;
let transport: ApiTransport | null = null;

/** Sends every `api()` call through `next` (null: back to the session cookie). */
export function setApiTransport(next: ApiTransport | null): void {
  transport = next;
}

/**
 * Answers a read when Tohyee can't be reached, from what's kept on this
 * device (#472 offline farm packs). Set by OfflineSupport for the signed-in
 * person and organisation; null answers "nothing kept".
 */
export type OfflineReader = (path: string, query: Record<string, string | number | boolean | null | undefined>) => Promise<{ body: unknown; savedAt: string } | { locked: true } | null>;
let offlineReader: OfflineReader | null = null;

export function setOfflineReader(next: OfflineReader | null): void {
  offlineReader = next;
}

/** Reads this page answered from the device, and when each was kept: for the "last known" label. */
const offlineServed = new Map<string, string>();
const servedListeners = new Set<() => void>();
let servedSnapshot: ReadonlyMap<string, string> = new Map();

export function subscribeOfflineServed(listener: () => void): () => void {
  servedListeners.add(listener);
  return () => {
    servedListeners.delete(listener);
  };
}

export function offlineServedSnapshot(): ReadonlyMap<string, string> {
  return servedSnapshot;
}

function noteServed(path: string, savedAt: string | null) {
  if (savedAt === null ? !offlineServed.has(path) : offlineServed.get(path) === savedAt) return;
  if (savedAt === null) offlineServed.delete(path);
  else offlineServed.set(path, savedAt);
  servedSnapshot = new Map(offlineServed);
  servedListeners.forEach((listener) => listener());
}

/** Gateway answers that mean Tohyee itself couldn't be reached (a tunnel with the computer off). */
const UNREACHABLE_STATUSES = new Set([502, 503, 504, 521, 522, 523, 530]);

async function fromDevice<T>(path: string, options: Options): Promise<T> {
  const answer = offlineReader && (options.method ?? "GET") === "GET" ? await offlineReader(path, options.query ?? {}).catch(() => null) : null;
  if (answer && "locked" in answer) throw new ApiError("What's kept on this device is locked: it's more than 14 days since you signed in with a connection. Sign in with a connection to open it.", 0, "offline_locked");
  if (answer) {
    noteServed(path, answer.savedAt);
    return answer.body as T;
  }
  throw new ApiError(OFFLINE_MESSAGE, 0, "offline");
}

/** What a request says when Tohyee can't be reached. */
export const OFFLINE_MESSAGE = "Tohyee can't be reached from this device just now. Check the connection, then try again.";

/** Calls the Tohyee API with the session cookie. Signs you out on 401. */
export async function api<T>(path: string, options: Options = {}): Promise<T> {
  if (transport) return (await transport(path, options)) as T;
  const url = new URL(path, window.location.origin);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    // No connection (or the server is down): what's kept on the device, or say so in words, not "Failed to fetch" (#472).
    return fromDevice<T>(path, options);
  }
  if (UNREACHABLE_STATUSES.has(response.status) && (options.method ?? "GET") === "GET") {
    try {
      return await fromDevice<T>(path, options);
    } catch {
      // Nothing kept: the gateway's own answer below.
    }
  }
  if (response.ok && (options.method ?? "GET") === "GET") noteServed(path, null);
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    // Full reload so the server re-checks the (now missing) session.
    window.location.assign(new URL("/login", window.location.origin).toString());
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status}).`;
    const { code, details } = errorFields(payload);
    throw new ApiError(message, response.status, code, details);
  }
  return payload as T;
}

/** Calls the Tohyee API for a downloadable file, with the same session handling as `api()`. */
export async function apiDownload(path: string, body: unknown): Promise<Blob> {
  // Not signed in with a session (the PowerPoint add-in): there are no downloads.
  if (transport) throw new ApiError("Downloads aren't available here.", 403);
  const response = await fetch(new URL(path, window.location.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    window.location.assign(new URL("/login", window.location.origin).toString());
  }
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return response.blob();
}

/**
 * A fresh idempotency key for one submission. Uses getRandomValues because
 * crypto.randomUUID isn't available on plain-HTTP LAN addresses.
 */
export function newIdempotencyKey(prefix = "ui"): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
