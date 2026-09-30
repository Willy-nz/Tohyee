import { HttpError, UnavailableError } from "@/lib/errors";

/**
 * The Tohyee address service: a small web service run by the Tohyee project
 * (a Cloudflare Worker) that hands a server an address such as
 * https://k7m2q9.tohyee.example and a Cloudflare Tunnel token for it, with no
 * sign-up. Tohyee then runs Cloudflare's connector with that token exactly as
 * it does for a tunnel you made yourself. The service only sets up the
 * address; requests go through Cloudflare's tunnel to this computer, and the
 * books never pass through the service.
 *
 * API (version 1):
 *   POST   {service}/v1/addresses  { port, installId, version }
 *          → 201 { hostname, tunnelToken, releaseKey }; the same installId gets the same address back
 *   DELETE {service}/v1/addresses/<hostname>  Authorization: Bearer <releaseKey>  → 204
 *   GET    {service}/v1/health  → { ok: true }
 *   Errors: { error: "message" } with 400/401/404/429/503.
 *
 * The call is made by the server (not the Windows app), so the command-line
 * tool on Linux and Docker can use it too.
 */
export const DEFAULT_ADDRESS_SERVICE = "https://relay.tohyee.example";
export const NOT_AVAILABLE = "The Tohyee address service isn't available yet.";

const QUICK_MS = 5000;
const SLOW_MS = 20000;

/** Where the service is: TOHYEE_ADDRESS_SERVICE_URL, or the project's own. */
export function addressServiceUrl(): string {
  const configured = process.env.TOHYEE_ADDRESS_SERVICE_URL?.trim();
  if (!configured) return DEFAULT_ADDRESS_SERVICE;
  try {
    const url = new URL(configured);
    // http only for a service on this computer (tests, or trying a copy of the service locally).
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_ADDRESS_SERVICE;
}

export type AddressServiceHealth = { url: string; available: boolean; message: string | null };

export type IssuedAddress = { hostname: string; tunnelToken: string; releaseKey: string };

async function call(method: string, path: string, init: { body?: unknown; bearer?: string; timeoutMs: number }): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "Tohyee" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  let response: Response;
  try {
    response = await fetch(`${addressServiceUrl()}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch {
    // Offline, not deployed yet, a name that doesn't resolve, or too slow.
    throw new UnavailableError(NOT_AVAILABLE);
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function refusal(status: number, body: unknown): HttpError {
  const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error.slice(0, 300) : null;
  // Something that isn't the service (a parked domain, a proxy page) answers without its JSON errors.
  if (!message) return new UnavailableError(NOT_AVAILABLE);
  const text = `The Tohyee address service said: ${message}`;
  if (status === 400 || status === 401 || status === 404 || status === 409 || status === 429) return new HttpError(status, "address_service", text);
  return new UnavailableError(text);
}

/** Whether the service is answering (GET /v1/health). Never throws. */
export async function checkAddressService(): Promise<AddressServiceHealth> {
  const url = addressServiceUrl();
  try {
    const { status, body } = await call("GET", "/v1/health", { timeoutMs: QUICK_MS });
    if (status === 200 && body && typeof body === "object" && (body as { ok?: unknown }).ok === true) return { url, available: true, message: null };
    const error = refusal(status, body);
    return { url, available: false, message: error.message };
  } catch (error) {
    return { url, available: false, message: error instanceof Error ? error.message : NOT_AVAILABLE };
  }
}

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Asks for this server's address (the same installId always gets the same one back). */
export async function requestAddress(input: { port: number; installId: string; version: string }): Promise<IssuedAddress> {
  const { status, body } = await call("POST", "/v1/addresses", { body: input, timeoutMs: SLOW_MS });
  if (status !== 200 && status !== 201) throw refusal(status, body);
  const answer = (body ?? {}) as { hostname?: unknown; tunnelToken?: unknown; releaseKey?: unknown };
  const hostname = typeof answer.hostname === "string" ? answer.hostname.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!HOSTNAME.test(hostname) || typeof answer.tunnelToken !== "string" || typeof answer.releaseKey !== "string" || !answer.releaseKey) {
    throw new UnavailableError("The Tohyee address service answered, but not with an address. Try again later.");
  }
  return { hostname, tunnelToken: answer.tunnelToken, releaseKey: answer.releaseKey };
}

/** Gives the address back (the service deletes its tunnel and DNS name). An address that's already gone counts as released. */
export async function releaseAddress(hostname: string, releaseKey: string): Promise<void> {
  const { status, body } = await call("DELETE", `/v1/addresses/${encodeURIComponent(hostname)}`, { bearer: releaseKey, timeoutMs: SLOW_MS });
  if (status === 204 || status === 200 || status === 404) return;
  throw refusal(status, body);
}
