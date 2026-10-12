import { isSecureRequest, readCookie } from "@/lib/auth/sessions";

/** The cookie a shared clock-in device keeps its token in (RS5). Only `/api/clock` reads it. */
export const CLOCK_COOKIE = "tohyee_clock";
const FIVE_YEARS = 5 * 365 * 24 * 60 * 60;

export function clockCookieHeader(request: Request, token: string): string {
  const parts = [`${CLOCK_COOKIE}=${encodeURIComponent(token)}`, "Path=/api/clock", "HttpOnly", "SameSite=Strict", `Max-Age=${FIVE_YEARS}`];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearClockCookieHeader(request: Request): string {
  const parts = [`${CLOCK_COOKIE}=`, "Path=/api/clock", "HttpOnly", "SameSite=Strict", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

export function readClockCookie(request: Request): string | null {
  return readCookie(request, CLOCK_COOKIE);
}
