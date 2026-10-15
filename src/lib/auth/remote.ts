import { pauseEndText, remotePausedUntil } from "@/lib/auth/remote-pause";
import { privateAddress } from "@/lib/analytics/mail-host";
import { forwardedAddresses, twoStepRequired } from "@/lib/auth/sessions";
import { localHostName } from "@/lib/net/local-names";
import { ForbiddenError } from "@/lib/errors";

/**
 * Whether a request came through remote access (#208 item 5, decision 534):
 * - Cloudflare (a tunnel on your own domain or the Tohyee address) adds its
 *   own headers, and Tailscale Funnel addresses end in .ts.net;
 * - any other way in from the internet (your own proxy, a port opened on the
 *   router) shows up as a public name or address in Host or
 *   X-Forwarded-Host, or a public address in X-Forwarded-For.
 * Every one of them is checked, not just the first: a visitor can add
 * headers, which only shuts themselves out, but can't remove the ones a
 * proxy adds. Next.js fills X-Forwarded-* in itself when they're missing, so
 * having them proves nothing; what's in them does.
 */
export function cameThroughRemoteAccess(headers: Headers): boolean {
  if (headers.has("cf-ray") || headers.has("cf-connecting-ip") || headers.has("tailscale-funnel-request")) return true;
  const hosts = [headers.get("host"), ...(headers.get("x-forwarded-host") ?? "").split(",")].filter((host): host is string => host !== null && host.trim() !== "");
  if (hosts.some((host) => host.toLowerCase().split(":")[0].endsWith(".ts.net") || !localHostName(host))) return true;
  return forwardedAddresses(headers).some((address) => !privateAddress(address));
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

export function remotePausedText(until: string): string {
  return `Remote access to Tohyee is paused until ${pauseEndText(until)} because of many failed sign-ins from the internet. It works as usual on the local network, and a server admin can resume it on the server computer.`;
}

/** Refuses requests through remote access while it's without two-step sign-in (#208) or paused after many failed sign-ins (decision 542). */
export async function assertRemoteAllowed(headers: Headers): Promise<void> {
  if (remoteWithoutTwoStep(headers)) throw new ForbiddenError(REMOTE_NEEDS_TWO_STEP);
  if (!cameThroughRemoteAccess(headers)) return;
  const until = await remotePausedUntil();
  if (until) throw new ForbiddenError(remotePausedText(until));
}

/** For pages: whether a request through remote access is refused (no session shown). */
export async function remoteRefused(headers: Headers): Promise<boolean> {
  if (remoteWithoutTwoStep(headers)) return true;
  return cameThroughRemoteAccess(headers) && (await remotePausedUntil()) !== null;
}
