import { cameThroughRemoteAccess } from "@/lib/auth/remote";
import { readServerSetting } from "@/lib/server-settings";

/**
 * The address a request was sent to, from its Host (decision 534). Not
 * X-Forwarded-Host: Next.js passes on whatever a visitor puts there, and the
 * tunnels Tohyee supports set Host to the public name themselves. The scheme
 * is only ever http or https.
 */
function requestHostOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : url.protocol.replace(":", "");
  const host = request.headers.get("host")?.trim() || url.host;
  return `${proto}://${host}`;
}

async function configuredPublicUrl(): Promise<string | null> {
  const remote = await readServerSetting<{ publicUrl?: string }, Record<string, never>>("remote_access");
  return remote.value.publicUrl ? remote.value.publicUrl.replace(/\/+$/, "") : null;
}

/**
 * The address people use to reach this server, for links in emails: the
 * remote access public address when one is set (so a forged Host header can't
 * change it), otherwise the address this request came in on.
 */
export async function publicOrigin(request: Request): Promise<string> {
  return (await configuredPublicUrl()) ?? requestHostOrigin(request);
}

/**
 * Where the browser that sent this request should come back to (after signing
 * in to Google or Microsoft, say), so its session cookie is there: the public
 * address when the request came through remote access and one is set, or the
 * address it came in on (the local network).
 */
export async function returnOrigin(request: Request): Promise<string> {
  if (cameThroughRemoteAccess(request.headers)) {
    const configured = await configuredPublicUrl();
    if (configured) return configured;
  }
  return requestHostOrigin(request);
}

/**
 * Tohyee's address when there's no request to read it from (a scheduled
 * job's email): the remote access public address, or null.
 */
export async function configuredOrigin(): Promise<string | null> {
  return configuredPublicUrl();
}
