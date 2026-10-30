import { writeAuditEvent } from "@/lib/audit";
import { dropTablesWithPrefix, mergeTableDays, replaceTableSet, tablesWithPrefix, type TableCopy } from "@/lib/analytics/engine";
import { GA_CALLBACK_PATH, newGoogleState } from "@/lib/analytics/google-analytics";
import {
  GSC_LOAD_TABLE_NAME,
  GSC_SEARCH_TYPES,
  GSC_SOURCE_NAME,
  GSC_TABLE_PREFIX,
  GSC_TABLES,
  type GscResponse,
  type GscSearchType,
  type GscTable,
  gscChangingFrom,
  gscDays,
  gscLoadWindow,
  gscReadAllPages,
  gscRequestBody,
  gscRows,
  gscSiteLabel,
  gscTableColumns,
  gscToday,
} from "@/lib/analytics/search-console-reports";
import { rebuildShapedTablesForTables, shapesUsing } from "@/lib/analytics/shaped-tables";
import { type LoadRun, requireAnalytics, RUN_COLUMNS, type RunRow, toRun } from "@/lib/analytics/sources";
import { authorisationUrl, exchangeCode, googleAccountAddress, ProviderError, providerFetch, type ProviderApp, refreshAccess, type Tokens } from "@/lib/crm/mail/providers";
import { googleApp } from "@/lib/crm/mail/service";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";

/*
 * Google Search Console as an Analytics data source (#512, decisions
 * 1180-1189, examples GSC1-GSC9), built like Google Analytics (606-609).
 * An admin signs in with Google through the organisation's own Google app
 * (Settings › Email), asking only to read Search Console; chooses one
 * verified property; and Tohyee loads its search data by day into
 * `google_search_console_*` tables: the first time as far back as Google
 * keeps (16 months), after that only the new days and the days that may
 * still change. Tokens are stored encrypted. Network calls happen outside
 * database transactions.
 */

export const GSC_READ_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
/** Reading Search Console, and the Google account's address (to show who connected). Nothing else. */
export const GSC_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", GSC_READ_SCOPE];
const API = "https://searchconsole.googleapis.com/webmasters/v3";
const TIMEOUT_MS = 60_000;
/** Days asked for at once (Google allows 1,200 questions a minute per site; four at a time stays well under). */
const PARALLEL_DAYS = 4;

export type GscConnection = {
  /** The Google account that signed in; only shown to admins and owners. */
  googleEmail: string | null;
  siteUrl: string | null;
  siteLabel: string | null;
  permissionLevel: string | null;
  searchType: GscSearchType;
  reloadDaily: boolean;
  needsReconnect: boolean;
  loadedFrom: string | null;
  loadedThrough: string | null;
  /** The first loaded day that may still change; it's fetched again next time. */
  changingFrom: string | null;
  connectedByEmail: string;
  connectedAt: string;
};
export type GscStatus = { connection: GscConnection | null; lastLoad: LoadRun | null; callbackPath: string; tables: string[] };
export type GscSite = { siteUrl: string; label: string; permissionLevel: string };

type ConnectionRow = {
  google_email: string;
  refresh_token_ciphertext: string;
  access_token_ciphertext: string | null;
  access_token_expires_at: Date | null;
  site_url: string | null;
  permission_level: string | null;
  search_type: GscSearchType;
  reload_daily: boolean;
  needs_reconnect: boolean;
  loaded_from: string | null;
  loaded_through: string | null;
  changing_from: string | null;
  connected_by_email: string;
  connected_at: Date;
};

const COLUMNS = `google_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, site_url, permission_level, search_type,
  reload_daily, needs_reconnect, loaded_from::text, loaded_through::text, changing_from::text, connected_by_email, connected_at`;

async function connectionRow(tx: OrgTx, lock = false): Promise<ConnectionRow | null> {
  const result = await tx.query<ConnectionRow>(`select ${COLUMNS} from analytics_search_console_connections where id = true${lock ? " for update" : ""}`);
  return result.rows[0] ?? null;
}

function toConnection(row: ConnectionRow, showEmail: boolean): GscConnection {
  return {
    googleEmail: showEmail ? row.google_email : null,
    siteUrl: row.site_url,
    siteLabel: row.site_url ? gscSiteLabel(row.site_url) : null,
    permissionLevel: row.permission_level,
    searchType: row.search_type,
    reloadDaily: row.reload_daily,
    needsReconnect: row.needs_reconnect,
    loadedFrom: row.loaded_from,
    loadedThrough: row.loaded_through,
    changingFrom: row.changing_from,
    connectedByEmail: row.connected_by_email,
    connectedAt: new Date(row.connected_at).toISOString(),
  };
}

/** The latest Search Console load, or null. */
export async function lastGscRun(tx: OrgTx): Promise<LoadRun | null> {
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from analytics_load_runs where source_id is null and table_name = $1 order by started_at desc, id desc limit 1`,
    [GSC_LOAD_TABLE_NAME],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

/** The connection (if any), its last load and its tables. Anyone in the organisation; the Google address only for admins. */
export async function getGscStatus(tx: OrgTx, isAdmin: boolean): Promise<GscStatus> {
  await requireAnalytics(tx);
  const row = await connectionRow(tx);
  return { connection: row ? toConnection(row, isAdmin) : null, lastLoad: await lastGscRun(tx), callbackPath: GA_CALLBACK_PATH, tables: GSC_TABLES.map((table) => table.table) };
}

function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GA_CALLBACK_PATH}`;
}

// Connecting (GSC1) ---------------------------------------------------------------------------

/** Google's sign-in address, asking only to read Search Console, returning to Google Analytics' address (decision 1180). The route checks the role. */
export async function startGscConnect(tx: OrgTx, origin: string): Promise<{ url: string }> {
  await requireAnalytics(tx);
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to connect Google Search Console.");
  if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store Google's sign-in.");
  const app = await googleApp(tx);
  const state = await newGoogleState(tx, "search_console");
  return { url: authorisationUrl("google", app, redirectUri(origin), state, GSC_SCOPES) };
}

export type GscSignIn = { tokens: Tokens; email: string };

/** Exchanges the code and finds the Google account's address (network, no transaction). */
export async function fetchGscSignIn(app: ProviderApp, code: string, origin: string): Promise<GscSignIn> {
  const tokens = await exchangeCode("google", app, code, redirectUri(origin));
  if (!tokens.refreshToken) throw new ValidationError("The sign-in didn't allow offline access, so Tohyee can't load every night. Try connecting again.");
  if (tokens.scope && !tokens.scope.split(/\s+/).includes(GSC_READ_SCOPE)) {
    throw new ValidationError("The sign-in didn't allow reading Search Console. Connect again and tick the box that lets Tohyee see your Search Console data.");
  }
  const email = (await googleAccountAddress(tokens.accessToken)).toLowerCase();
  return { tokens, email };
}

/** Stores the sign-in (tokens encrypted). Connecting again keeps the property, its settings and what's loaded. */
export async function saveGscSignIn(tx: OrgTx, signIn: GscSignIn, now = new Date()): Promise<GscConnection> {
  await requireAnalytics(tx);
  await tx.query(
    `insert into analytics_search_console_connections (id, google_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, connected_by_email)
     values (true, $1, $2, $3, $4, $5)
     on conflict (id) do update set google_email = excluded.google_email, refresh_token_ciphertext = excluded.refresh_token_ciphertext,
            access_token_ciphertext = excluded.access_token_ciphertext, access_token_expires_at = excluded.access_token_expires_at,
            connected_by_email = excluded.connected_by_email, connected_at = now(), needs_reconnect = false, updated_at = now()`,
    [
      signIn.email,
      encryptSecret(signIn.tokens.refreshToken!),
      encryptSecret(signIn.tokens.accessToken),
      new Date(now.getTime() + signIn.tokens.expiresInSeconds * 1000).toISOString(),
      tx.actor.email,
    ],
  );
  await writeAuditEvent(tx, { eventType: "analytics.search_console_connected", entityType: "analytics_search_console_connection", entityId: "google_search_console", details: { googleEmail: signIn.email } });
  return toConnection((await connectionRow(tx))!, true);
}

// Talking to Google ------------------------------------------------------------------------

let retryDelaysMs = [5_000, 15_000, 45_000];
/** Tests don't wait between retries. */
export function setGscRetryDelaysForTests(delays: number[] | null): void {
  retryDelaysMs = delays ?? [5_000, 15_000, 45_000];
}

class GscApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    readonly detail: string,
  ) {
    super(detail);
  }
  get quota(): boolean {
    return this.status === 429 || (this.status === 403 && /quota|rateLimit/i.test(this.reason ?? ""));
  }
}

/** What went wrong, in words an admin can act on (GSC6, GSC7). */
function gscProblem(error: GscApiError): Error {
  const google = error.detail ? ` Google said: ${error.detail.slice(0, 300)}` : "";
  if (error.quota) {
    return new UnavailableError("Google Search Console's limit for this site is used up for now (Google allows only so much in ten minutes and in a day).");
  }
  if (error.reason === "SERVICE_DISABLED" || error.reason === "accessNotConfigured" || /has not been used in project|is disabled/i.test(error.detail)) {
    return new ConflictError(
      `The Google Search Console API isn't turned on in the Google Cloud project of this organisation's Google app. An admin needs to enable it in Google Cloud (APIs & Services › Library), then try again.${google}`,
    );
  }
  if (error.status === 401) return new ConflictError("Google didn't accept the sign-in. Connect Google Search Console again.");
  if (error.status === 403) return new ConflictError(`Google says this Google account can't read that Search Console property.${google}`);
  if (error.status >= 500) return new UnavailableError(`Google Search Console isn't answering just now. The data already loaded is kept; try again later.${google}`);
  return new ValidationError(`Google Search Console refused the request (${error.status}).${google}`);
}

/**
 * One request. Google's per-minute limits and passing outages (429, a 403
 * quota or rate reason, 500, 503) are tried again after 5, 15 and 45
 * seconds; after that the error is given up (decision 1184).
 */
async function gscRequest<T>(url: string, token: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await providerFetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < retryDelaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        continue;
      }
      throw new UnavailableError(`Couldn't reach Google Search Console: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.ok) {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ValidationError("Google Search Console sent an answer Tohyee can't read.");
      return parsed as T;
    }
    const failure = (parsed as { error?: { message?: string; status?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> } } | null)?.error;
    const reason =
      failure?.errors?.find((entry) => typeof entry?.reason === "string")?.reason ?? failure?.details?.find((entry) => typeof entry?.reason === "string")?.reason ?? (failure?.status === "RESOURCE_EXHAUSTED" ? "rateLimitExceeded" : null);
    const error = new GscApiError(response.status, reason, typeof failure?.message === "string" ? failure.message : text.slice(0, 300));
    if ((error.quota || response.status === 500 || response.status === 503) && attempt < retryDelaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      continue;
    }
    throw error;
  }
}

async function loadConnection(organisation: OrganisationRecord, actor: Actor): Promise<{ row: ConnectionRow; app: ProviderApp }> {
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx);
    if (!row) throw new NotFoundError("Google Search Console isn't connected.");
    return { row, app: await googleApp(tx) };
  });
}

const reconnectMessage =
  "Google no longer accepts this Search Console sign-in (it ran out or was withdrawn). An admin needs to connect again. While the organisation's Google app is in Testing, Google ends sign-ins after 7 days.";

/** A current access token, refreshed (and stored) when it's about to run out. Google refusing the sign-in marks it for reconnecting (GSC7). */
async function accessToken(organisation: OrganisationRecord, actor: Actor, row: ConnectionRow, app: ProviderApp, now = new Date()): Promise<string> {
  if (row.needs_reconnect) throw new ConflictError(reconnectMessage);
  if (row.access_token_ciphertext && row.access_token_expires_at && new Date(row.access_token_expires_at).getTime() > now.getTime() + 60_000) {
    return decryptSecret(row.access_token_ciphertext);
  }
  let refreshed: Tokens;
  try {
    refreshed = await refreshAccess("google", app, decryptSecret(row.refresh_token_ciphertext));
  } catch (error) {
    if (error instanceof ProviderError && (error.code === "invalid_grant" || error.status === 401)) {
      await withOrganisationTransaction(organisation, actor, (tx) =>
        tx.query("update analytics_search_console_connections set needs_reconnect = true, access_token_ciphertext = null, updated_at = now() where id = true"),
      );
      throw new ConflictError(reconnectMessage);
    }
    throw error;
  }
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query(
      `update analytics_search_console_connections set access_token_ciphertext = $1, access_token_expires_at = $2,
              refresh_token_ciphertext = coalesce($3, refresh_token_ciphertext), updated_at = now() where id = true`,
      [encryptSecret(refreshed.accessToken), new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString(), refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : null],
    ),
  );
  return refreshed.accessToken;
}

// Choosing the property (GSC2) ----------------------------------------------------------------

type SiteList = { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> };

/** The verified Search Console properties the connected account can read (sites.list), unverified ones left out, domains first then by address. */
export async function listGscSites(organisation: OrganisationRecord, actor: Actor): Promise<GscSite[]> {
  const { row, app } = await loadConnection(organisation, actor);
  const token = await accessToken(organisation, actor, row, app);
  let result: SiteList;
  try {
    result = await gscRequest<SiteList>(`${API}/sites`, token);
  } catch (error) {
    throw error instanceof GscApiError ? gscProblem(error) : error;
  }
  const sites: GscSite[] = [];
  for (const entry of result.siteEntry ?? []) {
    const siteUrl = typeof entry.siteUrl === "string" ? entry.siteUrl : "";
    const level = typeof entry.permissionLevel === "string" ? entry.permissionLevel : "";
    if (!/^(https?:\/\/|sc-domain:)/.test(siteUrl) || siteUrl.length > 2048) continue;
    // An unverified property can't be read (Google's sites resource: siteUnverifiedUser).
    if (!level || level === "siteUnverifiedUser") continue;
    sites.push({ siteUrl, label: gscSiteLabel(siteUrl), permissionLevel: level });
  }
  const domain = (site: GscSite) => (site.siteUrl.startsWith("sc-domain:") ? 0 : 1);
  return sites.sort((a, b) => domain(a) - domain(b) || a.siteUrl.localeCompare(b.siteUrl));
}

/**
 * Chooses the property, the search type and nightly loading (GSC2).
 * `available` is what Google listed just now, needed only when the
 * property changes. A new property or search type starts again: what was
 * loaded is forgotten and the caller drops the tables once this commits.
 */
export async function saveGscSettings(
  tx: OrgTx,
  input: { siteUrl?: unknown; searchType?: unknown; reloadDaily?: unknown },
  available: GscSite[] | null,
): Promise<{ connection: GscConnection; startAgain: boolean }> {
  await requireAnalytics(tx);
  const row = await connectionRow(tx, true);
  if (!row) throw new NotFoundError("Google Search Console isn't connected.");
  let site: GscSite | null = null;
  if (input.siteUrl !== undefined && input.siteUrl !== row.site_url) {
    const wanted = typeof input.siteUrl === "string" ? input.siteUrl : "";
    site = available?.find((entry) => entry.siteUrl === wanted) ?? null;
    if (!site) throw new ValidationError("That property isn't a verified one this Google account can see. Open the list again.");
  }
  if (!site && !row.site_url) throw new ValidationError("Choose the Search Console property to load.");
  let searchType = row.search_type;
  if (input.searchType !== undefined) {
    if (!GSC_SEARCH_TYPES.some((entry) => entry.id === input.searchType)) throw new ValidationError("Choose web, images, videos or news.");
    searchType = input.searchType as GscSearchType;
  }
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? row.reload_daily : (input.reloadDaily as boolean);
  const startAgain = Boolean(site) || searchType !== row.search_type;
  await tx.query(
    `update analytics_search_console_connections set site_url = coalesce($1, site_url), permission_level = coalesce($2, permission_level),
            search_type = $3, reload_daily = $4,
            loaded_from = case when $5 then null else loaded_from end, loaded_through = case when $5 then null else loaded_through end,
            changing_from = case when $5 then null else changing_from end, updated_at = now() where id = true`,
    [site?.siteUrl ?? null, site?.permissionLevel ?? null, searchType, reloadDaily, startAgain],
  );
  await writeAuditEvent(tx, {
    eventType: "analytics.search_console_settings_saved",
    entityType: "analytics_search_console_connection",
    entityId: "google_search_console",
    details: { siteUrl: site?.siteUrl ?? row.site_url, searchType, reloadDaily },
  });
  return { connection: toConnection((await connectionRow(tx))!, true), startAgain: startAgain && Boolean(row.loaded_through) };
}

/** Drops the Search Console tables (after a property change or disconnecting). */
export function dropGscTables(organisationId: string): Promise<string[]> {
  return dropTablesWithPrefix(organisationId, GSC_TABLE_PREFIX);
}

// Loading (GSC3-GSC6) ------------------------------------------------------------------------

function queryUrl(siteUrl: string): string {
  return `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

async function readTable(token: string, siteUrl: string, searchType: GscSearchType, table: GscTable, from: string, to: string) {
  return gscReadAllPages(async (startRow) => {
    try {
      return await gscRequest<GscResponse>(queryUrl(siteUrl), token, gscRequestBody(table, from, to, startRow, searchType));
    } catch (error) {
      throw error instanceof GscApiError ? gscProblem(error) : error;
    }
  });
}

type DayRows = Map<string, NonNullable<GscResponse["rows"]>>;

/**
 * The tables asked for one day at a time, a few days at once, oldest first.
 * When a day fails, no new days are started; the days before the first
 * failure are kept (decision 1184).
 */
async function readDays(token: string, siteUrl: string, searchType: GscSearchType, days: string[]): Promise<{ byTable: Map<string, DayRows>; completeDays: number; firstIncomplete: string | null; error: Error | null }> {
  const perDay = GSC_TABLES.filter((table) => table.perDay);
  const byTable = new Map<string, DayRows>(perDay.map((table) => [table.table, new Map()]));
  const failedAt: number[] = [];
  let firstError: Error | null = null;
  let firstIncomplete: string | null = null;
  let next = 0;
  const worker = async () => {
    while (next < days.length && firstError === null) {
      const index = next++;
      const day = days[index];
      try {
        for (const table of perDay) {
          const read = await readTable(token, siteUrl, searchType, table, day, day);
          byTable.get(table.table)!.set(day, read.rows);
          if (read.firstIncompleteDate && (!firstIncomplete || read.firstIncompleteDate < firstIncomplete)) firstIncomplete = read.firstIncompleteDate;
        }
      } catch (error) {
        failedAt.push(index);
        firstError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_DAYS, days.length) }, worker));
  const completeDays = failedAt.length ? Math.min(...failedAt) : days.length;
  return { byTable, completeDays, firstIncomplete, error: firstError };
}

/**
 * Loads the chosen property now (nightly, or Refresh now). The record of the
 * load is written before and after; Google is read with no transaction
 * open. The first load goes back 16 months and later ones only fetch the
 * days not loaded and those that may still change; the days read are
 * written to every table together, so a failed load changes nothing, and
 * one stopped part-way by Google's limits keeps the whole days before it
 * (GSC3-GSC6).
 */
export async function refreshGsc(organisation: OrganisationRecord, actor: Actor, trigger: "schedule" | "manual", now = new Date()): Promise<LoadRun> {
  const started = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx);
    if (!row) throw new NotFoundError("Google Search Console isn't connected.");
    if (!row.site_url) throw new ConflictError("Choose the Search Console property to load first.");
    const busy = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [
      GSC_LOAD_TABLE_NAME,
    ]);
    if (busy.rows.length > 0) throw new ConflictError("Google Search Console is loading already.");
    const run = await tx.query<{ id: string }>(
      `insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger, requested_by_email)
       values (null, $1, $2, $3, $4, $5) returning id::text`,
      [GSC_SOURCE_NAME, GSC_LOAD_TABLE_NAME, `${gscSiteLabel(row.site_url)} (${row.search_type} search)`, trigger, trigger === "manual" ? actor.email : null],
    );
    return { runId: run.rows[0].id, row };
  });

  const began = performance.now();
  let rows: number | null = null;
  let error: string | null = null;
  let saved: { from: string; through: string; changingFrom: string | null; first: boolean } | null = null;
  try {
    const present = new Set(await tablesWithPrefix(organisation.id, GSC_TABLE_PREFIX));
    const today = gscToday(now);
    const window = gscLoadWindow(today, {
      loadedThrough: started.row.loaded_through,
      changingFrom: started.row.changing_from,
      tablesPresent: GSC_TABLES.every((table) => present.has(table.table)),
    });
    const { row, app } = await loadConnection(organisation, actor);
    const token = await accessToken(organisation, actor, row, app, now);
    const siteUrl = started.row.site_url!;
    const searchType = started.row.search_type;
    // Daily totals: one question for the whole span (a row a day). The rest: a day at a time.
    const daily = GSC_TABLES.find((table) => !table.perDay)!;
    const totals = await readTable(token, siteUrl, searchType, daily, window.from, window.to);
    const days = gscDays(window.from, window.to);
    const read = await readDays(token, siteUrl, searchType, days);
    if (read.completeDays === 0) throw read.error!;
    const through = days[read.completeDays - 1];
    const firstIncomplete = [totals.firstIncompleteDate, read.firstIncomplete].filter((value): value is string => Boolean(value)).sort()[0] ?? null;
    const changingFrom = gscChangingFrom(today, firstIncomplete);
    const kept = days.slice(0, read.completeDays);
    const tables: TableCopy[] = GSC_TABLES.map((table) => {
      const source = table.perDay ? kept.flatMap((day) => read.byTable.get(table.table)!.get(day) ?? []) : totals.rows.filter((entry) => typeof entry.keys?.[0] === "string" && entry.keys[0] <= through);
      return { name: table.table, columns: gscTableColumns(table), rows: gscRows(table, source, changingFrom) };
    });
    rows = window.first
      ? await replaceTableSet(organisation.id, GSC_TABLE_PREFIX, tables, "The Search Console data couldn't be loaded")
      : await mergeTableDays(organisation.id, GSC_TABLE_PREFIX, tables, { dateColumn: "date", from: window.from, through }, "The Search Console data couldn't be loaded");
    saved = { from: window.from, through, changingFrom: changingFrom <= through ? changingFrom : null, first: window.first };
    if (read.error) {
      error = `${read.error.message} Days up to ${formatDate(through)} are loaded; the next load carries on from ${formatDate(days[read.completeDays])}.`;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (caught instanceof UnavailableError && /limit/.test(error)) error += " The data already loaded is kept. Tohyee tries again at the next nightly load, or use Refresh now later.";
  }
  const milliseconds = Math.round(performance.now() - began);

  const run = await withOrganisationTransaction(organisation, actor, async (tx) => {
    if (saved) {
      await tx.query(
        `update analytics_search_console_connections set loaded_from = case when $1 then $2::date else coalesce(least(loaded_from, $2::date), $2::date) end,
                loaded_through = $3::date, changing_from = $4::date, updated_at = now() where id = true and site_url = $5 and search_type = $6`,
        [saved.first, saved.from, saved.through, saved.changingFrom, started.row.site_url, started.row.search_type],
      );
    }
    const result = await tx.query<RunRow>(
      `update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5 where id = $1 returning ${RUN_COLUMNS}`,
      [started.runId, error ? "failed" : "ok", rows === null ? null : String(rows), milliseconds, error],
    );
    return toRun(result.rows[0]);
  });
  if (saved) {
    try {
      await rebuildShapedTablesForTables(organisation, actor, GSC_TABLES.map((table) => table.table), trigger);
    } catch (caught) {
      console.warn("[tohyee] Shaped tables after loading Google Search Console:", caught instanceof Error ? caught.message : caught);
    }
  }
  return run;
}

/** Whether the nightly load should consider Search Console: a property chosen, nightly on, and the sign-in still good. */
export async function gscLoadsNightly(tx: OrgTx): Promise<boolean> {
  const row = await connectionRow(tx);
  return Boolean(row && row.site_url && row.reload_daily && !row.needs_reconnect);
}

// Disconnecting (GSC8) ------------------------------------------------------------------------

/**
 * Disconnects: deletes the tokens and the connection, then (after it
 * commits) asks Google to withdraw the sign-in and drops every
 * `google_search_console_*` table. The load history stays. Refused while a
 * shaped table is built from the data, or a load is running.
 */
export async function disconnectGsc(organisation: OrganisationRecord, actor: Actor): Promise<void> {
  const refreshToken = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx, true);
    if (!row) throw new NotFoundError("Google Search Console isn't connected.");
    const running = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [
      GSC_LOAD_TABLE_NAME,
    ]);
    if (running.rows.length > 0) throw new ConflictError("Google Search Console is loading. Try again when it's finished.");
    const users = new Set<string>();
    for (const table of GSC_TABLES) for (const name of await shapesUsing(tx, table.table)) users.add(name);
    if (users.size > 0) {
      const list = [...users];
      throw new ConflictError(`The shaped table${list.length === 1 ? "" : "s"} ${list.join(", ")} ${list.length === 1 ? "uses" : "use"} Search Console data. Change or remove ${list.length === 1 ? "it" : "them"} first.`);
    }
    await tx.query("delete from analytics_search_console_connections where id = true");
    await tx.query("delete from analytics_google_states where product = 'search_console'");
    await writeAuditEvent(tx, { eventType: "analytics.search_console_disconnected", entityType: "analytics_search_console_connection", entityId: "google_search_console", details: { siteUrl: row.site_url } });
    // Google may withdraw everything the account allowed this Google app, so not while Google Analytics uses the same account (decision 1188).
    const shared = await tx.query("select 1 from analytics_google_connections where google_email = $1", [row.google_email]);
    return shared.rows.length ? null : decryptSecret(row.refresh_token_ciphertext);
  });
  if (refreshToken) await withdraw(refreshToken);
  await dropGscTables(organisation.id);
}

/** Asks Google to withdraw a sign-in. A courtesy: the token is already deleted here, so a failure doesn't matter. */
async function withdraw(refreshToken: string): Promise<void> {
  try {
    await providerFetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Nothing more to do: the sign-in is gone from Tohyee.
  }
}
