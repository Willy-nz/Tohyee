import { randomBytes, timingSafeEqual } from "node:crypto";
import { ForbiddenError } from "@/lib/errors";

/**
 * Server settings (organisations, users, remote access, email, updates) only
 * work from the server computer itself. Tohyee opens a second address for
 * them, bound to 127.0.0.1 only (TOHYEE_ADMIN_PORT, default the main port + 1),
 * which hands each request on to the main server with a secret header. The
 * secret is made fresh each time the server starts and never leaves the
 * process, so a request can only carry it if it came in through that local
 * address: not from the network, and not through the Cloudflare Tunnel (which
 * connects to the main port). The Windows server app (installer/windows/tray)
 * uses the same address.
 */
export const LOCAL_ADMIN_HEADER = "x-tohyee-local-admin";

const holder = globalThis as typeof globalThis & { __tohyeeLocalAdminSecret?: string };

export function localAdminSecret(): string {
  holder.__tohyeeLocalAdminSecret ??= randomBytes(32).toString("hex");
  return holder.__tohyeeLocalAdminSecret;
}

/** The port the local-only server settings address listens on; null when it's turned off. */
export function localAdminPort(): number | null {
  const configured = process.env.TOHYEE_ADMIN_PORT?.trim();
  if (configured === "off" || configured === "0") return null;
  if (configured) {
    const port = Number(configured);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  }
  const main = Number(process.env.PORT?.trim() || "3000");
  return Number.isInteger(main) && main > 0 && main < 65535 ? main + 1 : null;
}

/** Where to open the server settings on the server computer. */
export function localAdminUrl(): string | null {
  const port = localAdminPort();
  return port ? `http://127.0.0.1:${port}/server` : null;
}

/** Whether a request came in through the local-only server settings address. */
export function isLocalAdminRequest(headers: Headers): boolean {
  const presented = headers.get(LOCAL_ADMIN_HEADER);
  if (!presented) return false;
  const expected = Buffer.from(localAdminSecret());
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const SERVER_COMPUTER_ONLY =
  "Server settings can only be changed on the server computer itself, in the Tohyee server app: on that computer, click the Tohyee icon by the clock, or open Tohyee server settings from the Start menu.";

export function assertLocalAdminRequest(headers: Headers): void {
  if (!isLocalAdminRequest(headers)) {
    throw new ForbiddenError(SERVER_COMPUTER_ONLY);
  }
}
