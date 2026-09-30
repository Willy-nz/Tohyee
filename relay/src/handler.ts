/**
 * Tohyee address: hands a Tohyee server a random <name>.<domain> address and a
 * Cloudflare Tunnel token. The server runs cloudflared with the token; people's
 * accounting data then goes browser -> Cloudflare -> that server, never through here.
 *
 * Public API (the Windows app depends on this exactly):
 *   POST   /v1/addresses             {port, installId, version} -> 201 {hostname, tunnelToken, releaseKey}
 *   DELETE /v1/addresses/<hostname>  Authorization: Bearer <releaseKey> -> 204
 *   GET    /v1/health                -> 200 {ok: true, ...}
 * Errors are {"error": "..."} with 400, 401, 403, 404, 429 or 503.
 *
 * Admin API (Authorization: Bearer <ADMIN_TOKEN>), used by scripts/admin.sh:
 *   GET  /v1/admin/addresses
 *   POST /v1/admin/addresses/<hostname>/block     switch one address off and keep it off
 *   POST /v1/admin/addresses/<hostname>/unblock   forget a blocked address
 *   GET  /v1/admin/registrations
 *   PUT  /v1/admin/registrations  {"open": false}  stop (or restart) new addresses
 *
 * Logs never contain tokens, keys, install IDs or IP addresses.
 */
import { CloudflareApi, CloudflareError, type Fetch } from "./cloudflare";
import { type Env, isSetUp, type Settings, settings } from "./config";
import { isLabel, matchesHash, randomKey, randomLabel, sameSecret, sha256Hex } from "./secrets";
import * as store from "./store";

export type Deps = { fetch: Fetch; now: () => Date };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 4096;
const CREATING_STALE_MS = 15 * 60 * 1000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function contactLine(s: Settings): string {
  return s.abuseContact ? ` If you need help, contact ${s.abuseContact}.` : "";
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(400, "The request is too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The request must be a JSON object.");
  return body as Record<string, unknown>;
}

function parseCreate(body: Record<string, unknown>): { port: number; installId: string; version: string | null } {
  const { port, installId, version } = body;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, "port must be a whole number from 1 to 65535.");
  }
  if (typeof installId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(installId)) {
    throw new HttpError(400, "installId must be 16 to 128 letters, digits, '-' or '_'. Generate it randomly once and keep it.");
  }
  if (version !== undefined && version !== null && (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(version))) {
    throw new HttpError(400, "version must be a short version number such as 0.2.2.");
  }
  return { port, installId, version: typeof version === "string" ? version : null };
}

function api(env: Env, s: Settings, deps: Deps): CloudflareApi {
  return new CloudflareApi(env.CF_API_TOKEN ?? "", s.accountId, s.zoneId, deps.fetch);
}

function logFailure(what: string, hostname: string, error: unknown): void {
  // Only the action, hostname and Cloudflare's numeric codes; never secrets.
  const detail = error instanceof CloudflareError ? error.message : error instanceof Error ? error.name : "unknown error";
  console.error(`${what} for ${hostname}: ${detail}`);
}

/** Per-IP counters are keyed by a hash of the IP address, never the address itself. */
async function ipKey(request: Request, env: Env, kind: string): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return `${kind}:${(await sha256Hex(`${env.ADMIN_TOKEN ?? ""}|${ip}`)).slice(0, 32)}`;
}

async function health(env: Env, s: Settings): Promise<Response> {
  return json(200, {
    ok: true,
    registrationsOpen: isSetUp(env, s) && (await store.registrationsOpen(env.DB)),
    abuseContact: s.abuseContact || null,
  });
}

async function createAddress(request: Request, env: Env, s: Settings, deps: Deps): Promise<Response> {
  const input = parseCreate(await readJson(request));
  const now = deps.now();

  if ((await store.bump(env.DB, await ipKey(request, env, "req"), now)) > s.requestsPerIpPerDay) {
    throw new HttpError(429, "Too many requests from your network today. Please try again tomorrow.");
  }
  if (!isSetUp(env, s)) throw new HttpError(503, "Tohyee addresses aren't available yet. Please try again later.");

  const installHash = await sha256Hex(`install:${input.installId}`);
  const cf = api(env, s, deps);
  const existing = await store.findByInstall(env.DB, installHash);
  if (existing) return existingAddress(existing, input, env, s, cf, deps);

  if (!(await store.registrationsOpen(env.DB))) {
    throw new HttpError(503, "New Tohyee addresses are switched off for now. Please try again later." + contactLine(s));
  }
  if ((await store.countInUse(env.DB)) >= s.maxActive) {
    throw new HttpError(503, "No new Tohyee addresses are available right now. Please try again later." + contactLine(s));
  }
  if ((await store.bump(env.DB, await ipKey(request, env, "new"), now)) > s.newPerIpPerDay) {
    throw new HttpError(429, "Your network has asked for too many new addresses today. Please try again tomorrow.");
  }
  if ((await store.bump(env.DB, "new:all", now)) > s.newPerDay) {
    throw new HttpError(429, "Tohyee has handed out as many new addresses as it can today. Please try again tomorrow.");
  }

  let hostname = "";
  for (let attempt = 0; attempt < 5 && !hostname; attempt++) {
    const candidate = `${randomLabel()}.${s.domain}`;
    if (await store.reserve(env.DB, { hostname: candidate, installHash, port: input.port, version: input.version }, now)) {
      hostname = candidate;
    } else if (await store.findByInstall(env.DB, installHash)) {
      // Another request for the same install got there first.
      throw new HttpError(503, "Your address is still being set up. Please try again in a minute.");
    }
  }
  if (!hostname) throw new HttpError(503, "Couldn't pick an address. Please try again.");

  let tunnelId: string | null = null;
  let dnsRecordId: string | null = null;
  try {
    const tunnel = await cf.createTunnel(`tohyee-${hostname.split(".")[0]}`);
    tunnelId = tunnel.id;
    await store.update(env.DB, hostname, { tunnel_id: tunnelId }, deps.now());
    await cf.setIngress(tunnelId, hostname, input.port);
    dnsRecordId = await cf.createDnsRecord(hostname, tunnelId);
    const releaseKey = randomKey();
    await store.update(
      env.DB,
      hostname,
      { dns_record_id: dnsRecordId, release_hash: await sha256Hex(`release:${releaseKey}`), status: "active" },
      deps.now(),
    );
    console.log(`Created address ${hostname}`);
    return json(201, { hostname, tunnelToken: tunnel.token, releaseKey });
  } catch (error) {
    logFailure("Creating address", hostname, error);
    await undo(env, cf, hostname, tunnelId, dnsRecordId, deps);
    throw new HttpError(503, "Couldn't set up an address right now. Please try again in a few minutes.");
  }
}

/**
 * The same install asked again. It gets the same address and a NEW release key
 * (the old key stops working), so a server that lost its key can still let the
 * address go. The port is updated if it changed.
 */
async function existingAddress(
  row: store.AddressRow,
  input: { port: number; version: string | null },
  env: Env,
  s: Settings,
  cf: CloudflareApi,
  deps: Deps,
): Promise<Response> {
  if (row.status === "blocked") {
    throw new HttpError(403, "This Tohyee address has been switched off." + (contactLine(s) || " Please contact the Tohyee project."));
  }
  if (row.status === "creating") {
    if (deps.now().getTime() - Date.parse(row.created_at) < CREATING_STALE_MS) {
      throw new HttpError(503, "Your address is still being set up. Please try again in a minute.");
    }
    // A set-up that never finished (the Worker was stopped part way). Start again.
    await undo(env, cf, row.hostname, row.tunnel_id, row.dns_record_id, deps);
    throw new HttpError(503, "Your address didn't finish setting up. Please try again in a minute.");
  }
  if (row.status !== "active" || !row.tunnel_id) {
    throw new HttpError(503, "Your address is being removed. Please try again later.");
  }
  try {
    if (row.port !== input.port) await cf.setIngress(row.tunnel_id, row.hostname, input.port);
    const tunnelToken = await cf.getTunnelToken(row.tunnel_id);
    const releaseKey = randomKey();
    await store.update(
      env.DB,
      row.hostname,
      { port: input.port, version: input.version, release_hash: await sha256Hex(`release:${releaseKey}`) },
      deps.now(),
    );
    return json(201, { hostname: row.hostname, tunnelToken, releaseKey });
  } catch (error) {
    logFailure("Returning address", row.hostname, error);
    throw new HttpError(503, "Couldn't fetch your address right now. Please try again in a few minutes.");
  }
}

/** Best-effort removal after a failed set-up. Leftovers are retried by the daily clean-up. */
async function undo(env: Env, cf: CloudflareApi, hostname: string, tunnelId: string | null, dnsRecordId: string | null, deps: Deps) {
  try {
    if (dnsRecordId) await cf.deleteDnsRecord(dnsRecordId);
    if (tunnelId) await cf.deleteTunnel(tunnelId);
    await store.remove(env.DB, hostname);
  } catch (error) {
    logFailure("Undoing address", hostname, error);
    await store.update(env.DB, hostname, { status: "releasing", install_hash: null, release_hash: null, dns_record_id: dnsRecordId }, deps.now());
  }
}

/**
 * Takes an address off the internet: the DNS record goes first (so the address
 * stops working straight away), then the tunnel. Cloudflare won't delete a
 * tunnel that's still connected, so if that fails the row stays "releasing"
 * (or "blocked") with the tunnel ID and the daily clean-up tries again.
 */
async function takeDown(env: Env, cf: CloudflareApi, row: store.AddressRow, finalStatus: "gone" | "blocked", deps: Deps): Promise<void> {
  if (row.dns_record_id) {
    await cf.deleteDnsRecord(row.dns_record_id);
  }
  await store.update(
    env.DB,
    row.hostname,
    {
      status: finalStatus === "blocked" ? "blocked" : "releasing",
      dns_record_id: null,
      release_hash: null,
      ...(finalStatus === "gone" ? { install_hash: null } : {}),
    },
    deps.now(),
  );
  if (row.tunnel_id) await finishTunnel(env, cf, row.hostname, row.tunnel_id, finalStatus, deps);
  else if (finalStatus === "gone") await store.remove(env.DB, row.hostname);
}

async function finishTunnel(env: Env, cf: CloudflareApi, hostname: string, tunnelId: string, finalStatus: "gone" | "blocked", deps: Deps) {
  try {
    try {
      await cf.cleanUpConnections(tunnelId);
    } catch (error) {
      logFailure("Disconnecting tunnel", hostname, error);
    }
    await cf.deleteTunnel(tunnelId);
    if (finalStatus === "gone") await store.remove(env.DB, hostname);
    else await store.update(env.DB, hostname, { tunnel_id: null }, deps.now());
  } catch (error) {
    logFailure("Deleting tunnel (will retry daily)", hostname, error);
  }
}

function hostnameFrom(raw: string, s: Settings): string {
  const hostname = decodeURIComponent(raw).trim().toLowerCase().replace(/\.$/, "");
  const suffix = `.${s.domain}`;
  if (!s.domain || !hostname.endsWith(suffix) || !isLabel(hostname.slice(0, -suffix.length))) {
    throw new HttpError(404, "There's no Tohyee address with that name.");
  }
  return hostname;
}

async function releaseAddress(request: Request, rawHostname: string, env: Env, s: Settings, deps: Deps): Promise<Response> {
  const hostname = hostnameFrom(rawHostname, s);
  const key = bearer(request);
  if (!key) throw new HttpError(401, "Send the address's release key as 'Authorization: Bearer <releaseKey>'.");
  const row = await store.findByHostname(env.DB, hostname);
  if (!row || row.status === "releasing" || row.status === "blocked") throw new HttpError(404, "There's no Tohyee address with that name.");
  if (!row.release_hash || !(await matchesHash(`release:${key}`, row.release_hash))) {
    throw new HttpError(401, "That release key isn't right for this address.");
  }
  if (!isSetUp(env, s)) throw new HttpError(503, "Tohyee addresses aren't available right now. Please try again later.");
  try {
    await takeDown(env, api(env, s, deps), row, "gone", deps);
  } catch (error) {
    logFailure("Releasing address", hostname, error);
    throw new HttpError(503, "Couldn't remove the address right now. Please try again in a few minutes.");
  }
  console.log(`Released address ${hostname}`);
  return new Response(null, { status: 204 });
}

async function admin(request: Request, path: string, env: Env, s: Settings, deps: Deps): Promise<Response> {
  const given = bearer(request);
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 20 || !given || !(await sameSecret(given, env.ADMIN_TOKEN))) {
    throw new HttpError(401, "Admin password missing or wrong.");
  }
  const method = request.method;
  if (path === "registrations") {
    if (method === "GET") return json(200, { open: await store.registrationsOpen(env.DB) });
    if (method === "PUT") {
      const body = await readJson(request);
      if (typeof body.open !== "boolean") throw new HttpError(400, 'Send {"open": true} or {"open": false}.');
      await store.setRegistrationsOpen(env.DB, body.open);
      console.log(`New addresses switched ${body.open ? "on" : "off"}`);
      return json(200, { open: body.open });
    }
  }
  if (path === "addresses" && method === "GET") {
    const rows = await store.listAll(env.DB);
    return json(200, {
      addresses: rows.map((r) => ({
        hostname: r.hostname,
        status: r.status,
        port: r.port,
        version: r.version,
        tunnelId: r.tunnel_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  }
  const action = /^addresses\/([^/]+)\/(block|unblock)$/.exec(path);
  if (action && method === "POST") {
    const hostname = hostnameFrom(action[1], s);
    const row = await store.findByHostname(env.DB, hostname);
    if (!row) throw new HttpError(404, "There's no Tohyee address with that name.");
    if (action[2] === "block") {
      if (!isSetUp(env, s)) throw new HttpError(503, "The Cloudflare settings aren't filled in.");
      try {
        await takeDown(env, api(env, s, deps), row, "blocked", deps);
      } catch (error) {
        logFailure("Blocking address", hostname, error);
        throw new HttpError(503, "Couldn't remove the DNS record. Try again, or delete it in the Cloudflare dashboard.");
      }
      console.log(`Blocked address ${hostname}`);
      return json(200, { hostname, status: "blocked" });
    }
    if (row.status !== "blocked") throw new HttpError(400, "Only a blocked address can be unblocked.");
    if (row.tunnel_id) throw new HttpError(503, "The tunnel is still being removed. Try again tomorrow.");
    await store.remove(env.DB, hostname);
    console.log(`Unblocked (forgot) address ${hostname}`);
    return json(200, { hostname, status: "forgotten" });
  }
  throw new HttpError(404, "Not found.");
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const s = settings(env);
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  try {
    if (path === "/v1/health" && request.method === "GET") return await health(env, s);
    if (path === "/v1/addresses" && request.method === "POST") return await createAddress(request, env, s, deps);
    const release = /^\/v1\/addresses\/([^/]+)$/.exec(path);
    if (release && request.method === "DELETE") return await releaseAddress(request, release[1], env, s, deps);
    if (path.startsWith("/v1/admin/")) return await admin(request, path.slice("/v1/admin/".length), env, s, deps);
    throw new HttpError(404, "Not found.");
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error(`Unexpected error: ${error instanceof Error ? error.name : "unknown"}`);
    return json(503, { error: "Something went wrong. Please try again later." + contactLine(s) });
  }
}

/** Daily tidy-up: old counters, tunnels that were still connected, half-finished set-ups. */
export async function cleanUp(env: Env, deps: Deps): Promise<void> {
  const s = settings(env);
  const now = deps.now();
  await store.forgetOldCounters(env.DB, now);
  if (!isSetUp(env, s)) return;
  const cf = api(env, s, deps);
  const rows = await store.listAll(env.DB);
  // Stay well inside the 50 outbound requests a Worker may make per run.
  let budget = 15;
  for (const row of rows) {
    if (budget <= 0) break;
    const stale = row.status === "creating" && now.getTime() - Date.parse(row.created_at) > CREATING_STALE_MS;
    if (stale) {
      budget--;
      await undo(env, cf, row.hostname, row.tunnel_id, row.dns_record_id, deps);
    } else if (row.status === "releasing") {
      budget--;
      try {
        if (row.dns_record_id) await cf.deleteDnsRecord(row.dns_record_id);
      } catch (error) {
        logFailure("Deleting DNS record", row.hostname, error);
        continue;
      }
      if (row.tunnel_id) await finishTunnel(env, cf, row.hostname, row.tunnel_id, "gone", deps);
      else await store.remove(env.DB, row.hostname);
    } else if (row.status === "blocked" && row.tunnel_id) {
      budget--;
      await finishTunnel(env, cf, row.hostname, row.tunnel_id, "blocked", deps);
    }
  }
}
