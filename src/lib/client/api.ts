"use client";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
};

/** Calls the Tohyee API with the session cookie. Signs you out on 401. */
export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    credentials: "same-origin",
  });
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
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

/** Calls the Tohyee API for a downloadable file, with the same session handling as `api()`. */
export async function apiDownload(path: string, body: unknown): Promise<Blob> {
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
