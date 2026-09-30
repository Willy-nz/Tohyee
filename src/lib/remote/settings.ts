import { randomBytes } from "node:crypto";
import packageJson from "../../../package.json";
import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { twoStepRequired } from "@/lib/auth/sessions";
import { withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, UnavailableError, ValidationError } from "@/lib/errors";
import { addressServiceUrl, releaseAddress, requestAddress } from "@/lib/remote/address-service";
import { cloudflaredProgram, startTunnel, stopTunnel, type TunnelState, tunnelState } from "@/lib/remote/tunnel";
import { secretsAvailable } from "@/lib/secrets";
import { deleteServerSetting, readServerSetting, writeServerSetting } from "@/lib/server-settings";
import { optionalString } from "@/lib/validation";
import { mainServerTarget } from "@/lib/server-admin/listener";

/**
 * Remote access (use Tohyee from anywhere), one of three ways; only one is on
 * at a time:
 *
 * - "tohyee" (recommended for most): a Tohyee address such as
 *   https://k7m2q9.tohyee.example from the Tohyee address service (run by
 *   the project; no sign-up). The service gives a Cloudflare Tunnel token and
 *   Tohyee runs Cloudflare's connector with it, as for "cloudflare". The token
 *   and the key for giving the address back are stored encrypted.
 * - "cloudflare" (your own domain): a Cloudflare Tunnel on the owner's own
 *   Cloudflare account, made by the Windows server app's Connect to Cloudflare
 *   or in Cloudflare's dashboard; Tohyee is given the tunnel token and runs
 *   Cloudflare's connector. The token is encrypted with TOHYEE_SECRET_KEY.
 * - "tailscale" (set up by the Windows server app): Tailscale Funnel runs in
 *   Tailscale's own Windows service and forwards
 *   https://<computer>.<tailnet>.ts.net to this server's main port. Tohyee
 *   doesn't run anything for it; this records that it's on and its address,
 *   so emailed links use it. The server app turns Funnel on only after this
 *   has been saved, so the two-step sign-in check below applies to it too.
 *
 * Switching keeps the other ways' tokens (and the Tohyee address), so
 * switching back is quick. Turning remote access on needs two-step sign-in to
 * be in force, so nobody can reach the server from the internet with a
 * password alone.
 */
export type RemoteMethod = "tohyee" | "cloudflare" | "tailscale";
type RemoteValue = { enabled: boolean; publicUrl: string | null; method?: RemoteMethod; tohyeeHostname?: string | null };
type RemoteSecrets = { tunnelToken: string; addressToken: string; releaseKey: string };
type AddressServiceSecrets = { installId: string };

const NEEDS_SECRET_KEY = "Set TOHYEE_SECRET_KEY on the server first: it turns on two-step sign-in and lets the tunnel token be stored encrypted.";

export type RemoteAccess = {
  /** How it reaches this server: a Tohyee address, your own domain on Cloudflare, or Tailscale Funnel. */
  method: RemoteMethod;
  enabled: boolean;
  publicUrl: string | null;
  hasToken: boolean;
  tunnelId: string | null;
  /** The Tohyee address this server holds (https://…), on or off; null when it has none. */
  tohyeeAddress: string | null;
  /** The Tohyee address service this server asks (TOHYEE_ADDRESS_SERVICE_URL). */
  addressService: string;
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
  if (input === "tailscale" || input === "tohyee") return input;
  throw new ValidationError("The remote access method is tohyee, cloudflare or tailscale.");
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
    tohyeeAddress: stored.value.tohyeeHostname && stored.secrets.addressToken ? `https://${stored.value.tohyeeHostname}` : null,
    addressService: addressServiceUrl(),
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
  const method = stored.value.method ?? "cloudflare";
  const token = method === "cloudflare" ? stored.secrets.tunnelToken : method === "tohyee" ? stored.secrets.addressToken : undefined;
  if (stored.value.enabled && token && twoStepRequired()) {
    startTunnel(token, localServiceAddress());
  } else {
    stopTunnel();
  }
}

/**
 * Saves remote access (server admins only): `method` ("cloudflare", the
 * default, "tailscale" or "tohyee"), `enabled`, `tunnelToken` (blank keeps
 * it), `publicUrl`; `clear: true` removes it (giving a Tohyee address back
 * first, if the service answers). Switching keeps the other ways' tokens, so
 * switching back is easy. A Tohyee address is got with getTohyeeAddress();
 * here "tohyee" only turns one this server already has on or off.
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
    const stored = await readServerSetting<RemoteValue, RemoteSecrets>("remote_access");
    if (stored.value.tohyeeHostname && stored.secrets.releaseKey) {
      // Best effort: the address is forgotten here either way, and asking the
      // service again (same install id) gets it back if this didn't reach it.
      await releaseAddress(stored.value.tohyeeHostname, stored.secrets.releaseKey).catch(() => undefined);
    }
    await withCoreTransaction(async (client) => {
      await deleteServerSetting(client, "remote_access");
      await writeAdminAuditEvent(client, actor, { eventType: "server.remote_access_cleared", entityType: "server_setting", entityId: "remote_access" });
    });
    if (apply) await applyRemoteAccess();
    return getRemoteAccess();
  }
  if (!secretsAvailable()) throw new UnavailableError(NEEDS_SECRET_KEY);
  const method = parseMethod(input.method);
  const enabled = input.enabled === true;
  const stored = await readServerSetting<RemoteValue, RemoteSecrets>("remote_access");
  const typed = optionalString(input.tunnelToken, "tunnelToken", { maxLength: 4000 });
  const tunnelToken = typed ? parseTunnelToken(typed).token : stored.secrets.tunnelToken;
  if (method === "cloudflare" && enabled && !tunnelToken) throw new ValidationError("Paste the tunnel token from Cloudflare first.");
  let publicUrl = input.publicUrl === undefined ? (stored.value.publicUrl ?? null) : parsePublicUrl(input.publicUrl);
  if (method === "tohyee") {
    const hostname = stored.value.tohyeeHostname;
    if (enabled && (!hostname || !stored.secrets.addressToken)) throw new ValidationError("This server doesn't have a Tohyee address yet. Get one first.");
    publicUrl = enabled && hostname ? `https://${hostname}` : null;
  }
  if (method === "tailscale" && enabled && (!publicUrl || !isTailscaleAddress(publicUrl))) {
    throw new ValidationError("The Tailscale Funnel address looks like https://computer.tailnet.ts.net.");
  }
  await withCoreTransaction(async (client) => {
    await writeServerSetting<RemoteValue, Partial<RemoteSecrets>>(
      client,
      "remote_access",
      { enabled, publicUrl, method, tohyeeHostname: stored.value.tohyeeHostname ?? null },
      { ...stored.secrets, ...(tunnelToken ? { tunnelToken } : {}) },
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

/**
 * This server's id for the address service, made once and kept (encrypted:
 * whoever has it can ask for this server's address and its tunnel token).
 */
async function installId(email: string): Promise<string> {
  const stored = await readServerSetting<Record<string, never>, AddressServiceSecrets>("address_service");
  if (stored.secrets.installId) return stored.secrets.installId;
  if (!stored.secretsReadable) {
    throw new UnavailableError("This server's id for the Tohyee address service can't be read (TOHYEE_SECRET_KEY has changed). Remove remote access and try again.");
  }
  const id = randomBytes(24).toString("base64url");
  await withCoreTransaction(async (client) => {
    await writeServerSetting(client, "address_service", {}, { installId: id }, email);
  });
  return id;
}

/**
 * Turns on a Tohyee address (server admins only): asks the Tohyee address
 * service for this server's address and tunnel token (unless it already has
 * one: then it's just turned back on), saves them encrypted and starts the
 * connector. The service call is made outside any database transaction.
 */
export async function getTohyeeAddress(auth: ServerAdminAuth, options: { apply?: boolean } = {}): Promise<RemoteAccess> {
  const apply = options.apply ?? true;
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can set up remote access.");
  if (!secretsAvailable()) throw new UnavailableError(NEEDS_SECRET_KEY);
  const stored = await readServerSetting<RemoteValue, RemoteSecrets>("remote_access");
  let hostname = stored.value.tohyeeHostname ?? null;
  let secrets: Partial<RemoteSecrets> = { ...stored.secrets };
  const isNew = !hostname || !stored.secrets.addressToken;
  if (isNew) {
    const issued = await requestAddress({ port: mainServerTarget().port, installId: await installId(auth.user.email), version: packageJson.version });
    try {
      parseTunnelToken(issued.tunnelToken);
    } catch {
      throw new UnavailableError("The Tohyee address service sent a tunnel token Tohyee can't use. Try again later.");
    }
    hostname = issued.hostname;
    secrets = { ...secrets, addressToken: issued.tunnelToken, releaseKey: issued.releaseKey };
  }
  const publicUrl = `https://${hostname}`;
  await withCoreTransaction(async (client) => {
    await writeServerSetting<RemoteValue, Partial<RemoteSecrets>>(
      client,
      "remote_access",
      { enabled: true, publicUrl, method: "tohyee", tohyeeHostname: hostname },
      secrets,
      auth.user.email,
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.remote_access_updated",
      entityType: "server_setting",
      entityId: "remote_access",
      details: { method: "tohyee", enabled: true, publicUrl, newAddress: isNew },
    });
  });
  if (apply) await applyRemoteAccess();
  return getRemoteAccess();
}

/**
 * Gives the Tohyee address back to the service (server admins only) and
 * forgets it. If it was in use, remote access is turned off. Refuses (and
 * keeps the address) when the service can't be reached, so it can be retried.
 */
export async function releaseTohyeeAddress(auth: ServerAdminAuth, options: { apply?: boolean } = {}): Promise<RemoteAccess> {
  const apply = options.apply ?? true;
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can set up remote access.");
  const stored = await readServerSetting<RemoteValue, RemoteSecrets>("remote_access");
  const hostname = stored.value.tohyeeHostname;
  if (!hostname) return getRemoteAccess();
  if (stored.secrets.releaseKey) await releaseAddress(hostname, stored.secrets.releaseKey);
  const inUse = stored.value.method === "tohyee";
  const secrets: Partial<RemoteSecrets> = { ...stored.secrets };
  delete secrets.addressToken;
  delete secrets.releaseKey;
  await withCoreTransaction(async (client) => {
    await writeServerSetting<RemoteValue, Partial<RemoteSecrets>>(
      client,
      "remote_access",
      {
        enabled: inUse ? false : (stored.value.enabled ?? false),
        publicUrl: inUse ? null : (stored.value.publicUrl ?? null),
        method: stored.value.method ?? "cloudflare",
        tohyeeHostname: null,
      },
      secrets,
      auth.user.email,
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.remote_access_address_released",
      entityType: "server_setting",
      entityId: "remote_access",
      details: { hostname },
    });
  });
  if (apply) await applyRemoteAccess();
  return getRemoteAccess();
}
