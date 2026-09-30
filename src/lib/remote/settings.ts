import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { twoStepRequired } from "@/lib/auth/sessions";
import { withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, UnavailableError, ValidationError } from "@/lib/errors";
import { cloudflaredProgram, startTunnel, stopTunnel, type TunnelState, tunnelState } from "@/lib/remote/tunnel";
import { secretsAvailable } from "@/lib/secrets";
import { deleteServerSetting, readServerSetting, writeServerSetting } from "@/lib/server-settings";
import { optionalString } from "@/lib/validation";
import { mainServerTarget } from "@/lib/server-admin/listener";

/**
 * Remote access (use Tohyee from anywhere), one of two ways:
 *
 * - "tailscale" (the easy way, set up by the Windows server app): Tailscale
 *   Funnel runs in Tailscale's own Windows service and forwards
 *   https://<computer>.<tailnet>.ts.net to this server's main port. Tohyee
 *   doesn't run anything for it; this records that it's on and its address,
 *   so emailed links use it. The server app turns Funnel on only after this
 *   has been saved, so the two-step sign-in check below applies to it too.
 * - "cloudflare" (the advanced way, your own domain): a server admin creates a
 *   Cloudflare Tunnel, points its public hostname at this server, and pastes
 *   the tunnel token here. Tohyee runs Cloudflare's connector. The token is
 *   encrypted with TOHYEE_SECRET_KEY.
 *
 * Turning remote access on needs two-step sign-in to be in force, so nobody
 * can reach the server from the internet with a password alone.
 */
export type RemoteMethod = "cloudflare" | "tailscale";
type RemoteValue = { enabled: boolean; publicUrl: string | null; method?: RemoteMethod };
type RemoteSecrets = { tunnelToken: string };

export type RemoteAccess = {
  /** How it reaches this server: Tailscale Funnel (the server app sets it up) or a Cloudflare Tunnel. */
  method: RemoteMethod;
  enabled: boolean;
  publicUrl: string | null;
  hasToken: boolean;
  tunnelId: string | null;
  /** The address to give Cloudflare as the tunnel's service. */
  localService: string;
  twoStepRequired: boolean;
  secretsAvailable: boolean;
  program: string;
  updatedAt: string | null;
  updatedByEmail: string | null;
  tunnel: TunnelState;
};

/** The local address cloudflared should forward to (127.0.0.1, not localhost, which can mean IPv6 on Windows). */
export function localServiceAddress(): string {
  const { host, port } = mainServerTarget();
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * Pulls the tunnel token out of whatever was pasted: the token itself, or
 * the whole install command Cloudflare shows ("cloudflared service install
 * eyJ…"). Checks it's shaped like a tunnel token.
 */
export function parseTunnelToken(input: string): { token: string; tunnelId: string } {
  const match = /eyJ[A-Za-z0-9+/=_-]{40,}/.exec(input.trim());
  if (!match) {
    throw new ValidationError("That doesn't look like a Cloudflare Tunnel token. Copy the long code starting eyJ from the tunnel's install command.");
  }
  let decoded: { a?: unknown; t?: unknown; s?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(match[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    throw new ValidationError("That tunnel token is incomplete. Copy it again from Cloudflare.");
  }
  if (typeof decoded.a !== "string" || typeof decoded.t !== "string" || typeof decoded.s !== "string") {
    throw new ValidationError("That tunnel token is incomplete. Copy it again from Cloudflare.");
  }
  return { token: match[0], tunnelId: decoded.t };
}

function parseMethod(input: unknown): RemoteMethod {
  if (input === undefined || input === null || input === "cloudflare") return "cloudflare";
  if (input === "tailscale") return "tailscale";
  throw new ValidationError("The remote access method is cloudflare or tailscale.");
}

/** Tailscale Funnel addresses are https://<computer>.<tailnet>.ts.net. */
function isTailscaleAddress(publicUrl: string): boolean {
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(publicUrl);
}

function parsePublicUrl(input: unknown): string | null {
  const text = optionalString(input, "publicUrl", { maxLength: 300 });
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new ValidationError("The public address should look like https://books.example.nz.");
  }
  if (url.protocol !== "https:") throw new ValidationError("The public address must start with https:// (Cloudflare provides the certificate).");
  if (url.pathname !== "/" || url.search || url.hash) throw new ValidationError("The public address is just the https://name, with nothing after it.");
  return url.origin;
}

export async function getRemoteAccess(): Promise<RemoteAccess> {
  const stored = await readServerSetting<RemoteValue, RemoteSecrets>("remote_access");
  let tunnelId: string | null = null;
  if (stored.secrets.tunnelToken) {
    try {
      tunnelId = parseTunnelToken(stored.secrets.tunnelToken).tunnelId;
    } catch {
      tunnelId = null;
    }
  }
  return {
    method: stored.value.method ?? "cloudflare",
    enabled: stored.value.enabled ?? false,
    publicUrl: stored.value.publicUrl ?? null,
    hasToken: Boolean(stored.secrets.tunnelToken),
    tunnelId,
    localService: localServiceAddress(),
    twoStepRequired: twoStepRequired(),
    secretsAvailable: secretsAvailable(),
    program: cloudflaredProgram(),
    updatedAt: stored.updatedAt,
    updatedByEmail: stored.updatedByEmail,
    tunnel: await tunnelState(),
  };
}

/** Starts or stops the tunnel to match the saved settings (on start-up and after a change). */
export async function applyRemoteAccess(): Promise<void> {
  const stored = await readServerSetting<RemoteValue, RemoteSecrets>("remote_access");
  const cloudflare = (stored.value.method ?? "cloudflare") === "cloudflare";
  if (cloudflare && stored.value.enabled && stored.secrets.tunnelToken && twoStepRequired()) {
    startTunnel(stored.secrets.tunnelToken);
  } else {
    stopTunnel();
  }
}

/**
 * Saves remote access (server admins only): `method` ("cloudflare", the
 * default, or "tailscale"), `enabled`, `tunnelToken` (blank keeps it),
 * `publicUrl`; `clear: true` removes it. Switching to Tailscale stops the
 * Cloudflare connector but keeps its token, so switching back is easy.
 */
export async function updateRemoteAccess(
  auth: ServerAdminAuth,
  input: { method?: unknown; enabled?: unknown; tunnelToken?: unknown; publicUrl?: unknown; clear?: unknown },
  options: { apply?: boolean } = {},
): Promise<RemoteAccess> {
  // The running server starts or stops the tunnel. The command-line tool is a
  // separate process that exits straight away, so it only saves (apply: false)
  // and the server picks the change up when it's restarted.
  const apply = options.apply ?? true;
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can set up remote access.");
  const actor = { userId: auth.user.id, email: auth.user.email };
  if (input.clear === true) {
    await withCoreTransaction(async (client) => {
      await deleteServerSetting(client, "remote_access");
      await writeAdminAuditEvent(client, actor, { eventType: "server.remote_access_cleared", entityType: "server_setting", entityId: "remote_access" });
    });
    if (apply) await applyRemoteAccess();
    return getRemoteAccess();
  }
  if (!secretsAvailable()) {
    throw new UnavailableError("Set TOHYEE_SECRET_KEY on the server first: it turns on two-step sign-in and lets the tunnel token be stored encrypted.");
  }
  const method = parseMethod(input.method);
  const enabled = input.enabled === true;
  const stored = await readServerSetting<RemoteValue, RemoteSecrets>("remote_access");
  const typed = optionalString(input.tunnelToken, "tunnelToken", { maxLength: 4000 });
  const tunnelToken = typed ? parseTunnelToken(typed).token : stored.secrets.tunnelToken;
  if (method === "cloudflare" && enabled && !tunnelToken) throw new ValidationError("Paste the tunnel token from Cloudflare first.");
  const publicUrl = input.publicUrl === undefined ? (stored.value.publicUrl ?? null) : parsePublicUrl(input.publicUrl);
  if (method === "tailscale" && enabled && (!publicUrl || !isTailscaleAddress(publicUrl))) {
    throw new ValidationError("The Tailscale Funnel address looks like https://computer.tailnet.ts.net.");
  }
  await withCoreTransaction(async (client) => {
    await writeServerSetting<RemoteValue, Partial<RemoteSecrets>>(
      client,
      "remote_access",
      { enabled, publicUrl, method },
      tunnelToken ? { tunnelToken } : {},
      auth.user.email,
    );
    await writeAdminAuditEvent(client, actor, {
      eventType: "server.remote_access_updated",
      entityType: "server_setting",
      entityId: "remote_access",
      details: { method, enabled, publicUrl, tokenChanged: Boolean(typed) },
    });
  });
  if (apply) await applyRemoteAccess();
  return getRemoteAccess();
}
