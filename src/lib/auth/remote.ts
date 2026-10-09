import { twoStepRequired } from "@/lib/auth/sessions";
import { ForbiddenError } from "@/lib/errors";

/**
 * Whether a request came through remote access: Cloudflare (a tunnel on your
 * own domain or the Tohyee address) adds its own headers, and Tailscale Funnel
 * addresses end in .ts.net. A visitor can add these headers to look remote,
 * which only shuts themselves out; they can't remove the ones Cloudflare adds
 * or change Funnel's address.
 */
export function cameThroughRemoteAccess(headers: Headers): boolean {
  if (headers.has("cf-ray") || headers.has("cf-connecting-ip") || headers.has("tailscale-funnel-request")) return true;
  const hosts = [headers.get("x-forwarded-host"), headers.get("host")];
  return hosts.some((host) => host !== null && host.toLowerCase().split(":")[0].endsWith(".ts.net"));
}

export const REMOTE_NEEDS_TWO_STEP =
  "Signing in through remote access needs two-step sign-in, which is off on this server because its secret key (TOHYEE_SECRET_KEY) isn't set. Use Tohyee on the local network, or ask the server admin to set the key.";

/**
 * #208 item 5: without the secret key there's no two-step sign-in, and the
 * Cloudflare connector stops by itself, but Tailscale Funnel runs in
 * Tailscale's own service and stays on. So sign-ins and sessions arriving
 * through remote access are refused while two-step sign-in is off.
 */
export function remoteWithoutTwoStep(headers: Headers): boolean {
  return !twoStepRequired() && cameThroughRemoteAccess(headers);
}

export function assertRemoteAllowed(headers: Headers): void {
  if (remoteWithoutTwoStep(headers)) throw new ForbiddenError(REMOTE_NEEDS_TWO_STEP);
}
