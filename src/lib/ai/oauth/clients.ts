import { coreQuery } from "@/lib/db/transactions";
import { cleanClientName, isMetadataDocumentClientId, metadataCacheSeconds, randomToken, redirectHost, redirectUriProblem } from "@/lib/ai/oauth/format";
import { publicFetch } from "@/lib/net/public-fetch";
import { remoteAccessAddress } from "@/lib/ai/tokens";
import { OFFICE_APP_NAME, officeAddressesFor } from "@/lib/office/addin";

/*
 * The AI apps that sign in (decision 812). Two ways, as the MCP
 * authorisation specification has them:
 *  - a client ID metadata document: the app's client_id is an https address
 *    where it publishes its name and redirect addresses; Tohyee reads it
 *    (only from a public address, no redirects, at most 5 KB, 5 seconds),
 *    checks it, and keeps it for its cache time (5 minutes to a day);
 *  - dynamic client registration (RFC 7591): the app sends its name and
 *    redirect addresses and gets a random client_id. Anyone can register,
 *    so registering grants nothing: only the person's consent does.
 * All apps are public clients (no secret); PKCE stands in for one.
 */

export type OAuthClient = {
  clientId: string;
  /**
   * "built_in": Tohyee's own PowerPoint add-in (#429, decision 834). Its
   * client_id is the address of its metadata document on this server, but
   * Tohyee knows it without reading it, and only it gets tokens for the
   * Analytics API for Office.
   */
  source: "registered" | "metadata_document" | "built_in";
  name: string;
  redirectUris: string[];
};

export class ClientProblem extends Error {}

const MAX_REDIRECT_URIS = 10;
const METADATA_MAX_BYTES = 5 * 1024;
const METADATA_TIMEOUT_MS = 5_000;

type Fetcher = (url: string, init: { signal: AbortSignal; maxBytes: number; headers: Record<string, string> }) => Promise<Response>;
const realFetch: Fetcher = (url, init) => publicFetch(url, { method: "GET", headers: init.headers, signal: init.signal, maxBytes: init.maxBytes });
let fetcher: Fetcher = realFetch;

/** Tests serve made-up metadata documents here; Tohyee never calls a real AI service in tests. */
export function setClientMetadataFetcherForTests(next: Fetcher | null): void {
  fetcher = next ?? realFetch;
}

function checkRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ClientProblem("The app didn't give any redirect addresses (redirect_uris).");
  if (value.length > MAX_REDIRECT_URIS) throw new ClientProblem(`The app gave more than ${MAX_REDIRECT_URIS} redirect addresses.`);
  for (const uri of value) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new ClientProblem(problem);
  }
  return [...new Set(value as string[])];
}

function checkGrantTypes(metadata: Record<string, unknown>): void {
  const grants = metadata.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes("authorization_code"))) {
    throw new ClientProblem("Tohyee only signs apps in with the authorisation code grant (grant_types must include authorization_code).");
  }
  const responses = metadata.response_types;
  if (responses !== undefined && (!Array.isArray(responses) || !responses.includes("code"))) {
    throw new ClientProblem("Tohyee only answers with a code (response_types must include code).");
  }
}

/**
 * RFC 7591 registration. Returns what the app is registered with, which may
 * differ from what it asked for: always a public client
 * (token_endpoint_auth_method "none") with the code and refresh grants.
 * Registrations never used within a day are cleared out as new ones come.
 */
export async function registerClient(metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
  const redirectUris = checkRedirectUris(metadata.redirect_uris);
  checkGrantTypes(metadata);
  const name = cleanClientName(metadata.client_name) ?? redirectHost(redirectUris[0]);
  const clientId = randomToken("tohyee_client_");
  await coreQuery("delete from oauth_clients where source = 'registered' and last_used_at is null and created_at < now() - interval '1 day'");
  const inserted = await coreQuery<{ issued: string }>(
    `insert into oauth_clients (client_id, source, client_name, redirect_uris) values ($1, 'registered', $2, $3::jsonb)
     returning extract(epoch from created_at)::bigint::text as issued`,
    [clientId, name, JSON.stringify(redirectUris)],
  );
  return {
    client_id: clientId,
    client_id_issued_at: Number(inserted.rows[0].issued),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

type ClientRow = { client_id: string; source: OAuthClient["source"]; client_name: string; redirect_uris: string[]; fresh: boolean };

function toClient(row: ClientRow): OAuthClient {
  return { clientId: row.client_id, source: row.source, name: row.client_name, redirectUris: row.redirect_uris };
}

/** Reads and checks an app's metadata document (decision 812). */
async function fetchMetadataDocument(clientId: string): Promise<{ name: string; redirectUris: string[]; cacheSeconds: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetcher(clientId, { signal: controller.signal, maxBytes: METADATA_MAX_BYTES, headers: { accept: "application/json" } });
    text = await response.text();
  } catch {
    throw new ClientProblem(`Tohyee couldn't read the app's details from ${redirectHost(clientId)}.`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 200) throw new ClientProblem(`${redirectHost(clientId)} didn't send the app's details (it answered ${response.status}).`);
  let metadata: unknown;
  try {
    metadata = JSON.parse(text);
  } catch {
    throw new ClientProblem(`The app's details at ${redirectHost(clientId)} aren't JSON.`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new ClientProblem("The app's details aren't a JSON object.");
  const record = metadata as Record<string, unknown>;
  // The document must name itself, exactly (draft-ietf-oauth-client-id-metadata-document section 4.1).
  if (record.client_id !== clientId) throw new ClientProblem("The app's details give a different client_id from the address they came from.");
  if ("client_secret" in record || "client_secret_expires_at" in record) throw new ClientProblem("The app's details include a client secret, which a metadata document mustn't.");
  const name = cleanClientName(record.client_name);
  if (!name) throw new ClientProblem("The app's details have no name (client_name).");
  const redirectUris = checkRedirectUris(record.redirect_uris);
  checkGrantTypes(record);
  return { name, redirectUris, cacheSeconds: metadataCacheSeconds(response.headers.get("cache-control")) };
}

/**
 * The app a client_id names, or a ClientProblem saying why it can't sign in.
 * A metadata document is read again once its cache time has passed.
 */
export async function resolveClient(clientIdInput: unknown): Promise<OAuthClient> {
  if (typeof clientIdInput !== "string" || clientIdInput.length === 0 || clientIdInput.length > 500) throw new ClientProblem("The app didn't say who it is (client_id).");
  const clientId = clientIdInput;
  const office = await builtInOfficeClient();
  if (office && clientId === office.clientId) return office;
  const found = await coreQuery<ClientRow>(
    `select client_id, source, client_name, redirect_uris, (expires_at is null or expires_at > now()) as fresh from oauth_clients where client_id = $1`,
    [clientId],
  );
  const row = found.rows[0];
  if (row && (row.source === "registered" || row.fresh)) return toClient(row);
  if (!isMetadataDocumentClientId(clientId)) throw new ClientProblem("Tohyee doesn't know this app. It needs to register again, or give the https address of its details.");
  const document = await fetchMetadataDocument(clientId);
  const saved = await coreQuery<ClientRow>(
    `insert into oauth_clients (client_id, source, client_name, redirect_uris, fetched_at, expires_at)
     values ($1, 'metadata_document', $2, $3::jsonb, now(), now() + make_interval(secs => $4))
     on conflict (client_id) do update set client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
       fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
       where oauth_clients.source = 'metadata_document'
     returning client_id, source, client_name, redirect_uris, true as fresh`,
    [clientId, document.name, JSON.stringify(document.redirectUris), document.cacheSeconds],
  );
  if (!saved.rows[0]) throw new ClientProblem("Tohyee doesn't know this app.");
  return toClient(saved.rows[0]);
}

/** Tohyee's PowerPoint add-in as an app, while remote access is on with an https address (decision 834). */
export async function builtInOfficeClient(): Promise<OAuthClient | null> {
  const addresses = officeAddressesFor(await remoteAccessAddress());
  if (!addresses) return null;
  return { clientId: addresses.clientId, source: "built_in", name: OFFICE_APP_NAME, redirectUris: [addresses.redirectUri] };
}

export async function markClientUsed(clientId: string): Promise<void> {
  await coreQuery("update oauth_clients set last_used_at = now() where client_id = $1", [clientId]);
}
