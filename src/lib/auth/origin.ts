import { readServerSetting } from "@/lib/server-settings";

/**
 * The address people use to reach this server, for links in emails: the
 * remote access public address when one is set (so a forged Host header can't
 * change it), otherwise the address this request came in on.
 */
export async function publicOrigin(request: Request): Promise<string> {
  const remote = await readServerSetting<{ publicUrl?: string }, Record<string, never>>("remote_access");
  if (remote.value.publicUrl) return remote.value.publicUrl.replace(/\/+$/, "");
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

/**
 * Tohyee's address when there's no request to read it from (a scheduled
 * job's email): the remote access public address, or null.
 */
export async function configuredOrigin(): Promise<string | null> {
  const remote = await readServerSetting<{ publicUrl?: string }, Record<string, never>>("remote_access");
  return remote.value.publicUrl ? remote.value.publicUrl.replace(/\/+$/, "") : null;
}
