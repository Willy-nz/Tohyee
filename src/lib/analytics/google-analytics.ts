import { randomBytes } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { replaceTableSet, dropTablesWithPrefix, type TableCopy } from "@/lib/analytics/engine";
import {
  GA_LOAD_TABLE_NAME,
  GA_MAX_HISTORY_MONTHS,
  GA_MAX_ROWS_PER_REPORT,
  GA_REPORTS,
  GA_SOURCE_NAME,
  GA_TABLE_PREFIX,
  type GaReport,
  type GaReportResponse,
  gaHistoryStart,
  gaReportRequest,
  gaRows,
  gaTableColumns,
} from "@/lib/analytics/google-analytics-reports";
import { rebuildShapedTablesForTables, shapesUsing } from "@/lib/analytics/shaped-tables";
import { type LoadRun, requireAnalytics, RUN_COLUMNS, type RunRow, toRun } from "@/lib/analytics/sources";
import { authorisationUrl, exchangeCode, googleAccountAddress, ProviderError, providerFetch, type ProviderApp, refreshAccess, type Tokens } from "@/lib/crm/mail/providers";
import { googleApp } from "@/lib/crm/mail/service";
import { todayIsoDate } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";

/*
 * Google Analytics (GA4) as an Analytics data source (decisions 606-609,
 * examples GA1-GA8). An admin signs in with Google through the
 * organisation's own Google app (Settings › Email), asking only to read
 * Analytics (plus the account's address, to show who connected); chooses
 * one GA4 property; and Tohyee loads a set of daily reports from Google's
 * Data API into the organisation's analytics copy as `google_analytics_*`
 * tables, nightly and by Refresh now. Tokens are stored encrypted.
 * Network calls happen outside database transactions.
 */

export const GA_CALLBACK_PATH = "/api/analytics/google/callback";
export const GA_READ_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
/** Reading Analytics, and the Google account's address (OAuth2 userinfo needs openid and userinfo.email). */
export const GA_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", GA_READ_SCOPE];
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const STATE_MINUTES = 15;
const TIMEOUT_MS = 60_000;
/** Account summary pages read at most (200 accounts a page). */
const MAX_ACCOUNT_PAGES = 25;

export type GaConnection = {
  /** The Google account that signed in; only shown to admins and owners. */
  googleEmail: string | null;
  propertyId: string | null;
  propertyName: string | null;
  accountName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  historyMonths: number;
  reloadDaily: boolean;
  needsReconnect: boolean;
  connectedByEmail: string;
  connectedAt: string;
};
export type GaStatus = { connection: GaConnection | null; lastLoad: LoadRun | null; callbackPath: string; tables: string[] };
export type GaProperty = { id: string; name: string; account: string };

type ConnectionRow = {
  google_email: string;
  refresh_token_ciphertext: string;
  access_token_ciphertext: string | null;
  access_token_expires_at: Date | null;
  property_id: string | null;
  property_name: string | null;
  account_name: string | null;
  currency_code: string | null;
  time_zone: string | null;
  history_months: number;
  reload_daily: boolean;
  needs_reconnect: boolean;
  connected_by_email: string;
  connected_at: Date;
};

async function connectionRow(tx: OrgTx, lock = false): Promise<ConnectionRow | null> {
  const result = await tx.query<ConnectionRow>(`select * from analytics_google_connections where id = true${lock ? " for update" : ""}`);
  return result.rows[0] ?? null;
}

function toConnection(row: ConnectionRow, showEmail: boolean): GaConnection {
  return {
    googleEmail: showEmail ? row.google_email : null,
    propertyId: row.property_id,
    propertyName: row.property_name,
    accountName: row.account_name,
    currencyCode: row.currency_code,
    timeZone: row.time_zone,
    historyMonths: row.history_months,
    reloadDaily: row.reload_daily,
    needsReconnect: row.needs_reconnect,
    connectedByEmail: row.connected_by_email,
    connectedAt: new Date(row.connected_at).toISOString(),
  };
}

/** The latest Google Analytics load, or null. */
export async function lastGaRun(tx: OrgTx): Promise<LoadRun | null> {
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from analytics_load_runs where source_id is null and table_name = $1 order by started_at desc, id desc limit 1`,
    [GA_LOAD_TABLE_NAME],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

/** The connection (if any), its last load and the tables it loads. Anyone in the organisation; the Google address only for admins. */
export async function getGaStatus(tx: OrgTx, isAdmin: boolean): Promise<GaStatus> {
  await requireAnalytics(tx);
  const row = await connectionRow(tx);
  return {
    connection: row ? toConnection(row, isAdmin) : null,
    lastLoad: await lastGaRun(tx),
    callbackPath: GA_CALLBACK_PATH,
    tables: GA_REPORTS.map((report) => report.table),
  };
}

function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GA_CALLBACK_PATH}`;
}

// Connecting (GA1) ---------------------------------------------------------------------------

/** Google's sign-in address, with a one-time state tied to this admin and organisation. The route checks the role. */
export async function startGaConnect(tx: OrgTx, origin: string): Promise<{ url: string }> {
  await requireAnalytics(tx);
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to connect Google Analytics.");
  if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store Google's sign-in.");
  const app = await googleApp(tx);
  const state = await newGoogleState(tx, "analytics");
  return { url: authorisationUrl("google", app, redirectUri(origin), state, GA_SCOPES) };
}

/** Which connection a Google sign-in is for: Google Analytics, or Google Search Console (decision 1180). They share the return address. */
export type GoogleProduct = "analytics" | "search_console";

/**
 * Checks a sign-in's state (unused, under 15 minutes old, the same admin)
 * and marks it used, before the code is exchanged. Says which connection
 * it's for, so the one return address can finish either.
 */
export async function claimGoogleState(tx: OrgTx, state: string): Promise<{ app: ProviderApp; product: GoogleProduct }> {
  await requireAnalytics(tx);
  const found = await tx.query<{ user_id: string; fresh: boolean; used_at: string | null; product: GoogleProduct }>(
    `select user_id, created_at > now() - make_interval(mins => $2) as fresh, used_at, product from analytics_google_states where state = $1 for update`,
    [state, STATE_MINUTES],
  );
  const row = found.rows[0];
  if (!row || row.used_at || !row.fresh || row.user_id !== tx.actor.userId) {
    throw new ValidationError("That sign-in link has expired or was already used. Start connecting again.");
  }
  await tx.query("update analytics_google_states set used_at = now() where state = $1", [state]);
  return { app: await googleApp(tx), product: row.product };
}

/** Which connection a sign-in state was started for (even once used), so an error goes back to the right screen; null when there's no such state. */
export async function googleStateProduct(tx: OrgTx, state: string): Promise<GoogleProduct | null> {
  const found = await tx.query<{ product: GoogleProduct }>("select product from analytics_google_states where state = $1", [state]);
  return found.rows[0]?.product ?? null;
}

/** Starts a sign-in's one-time state for this admin (shared by Google Analytics and Search Console). */
export async function newGoogleState(tx: OrgTx, product: GoogleProduct): Promise<string> {
  const state = `${tx.organisationId}.${randomBytes(24).toString("base64url")}`;
  await tx.query("delete from analytics_google_states where created_at < now() - interval '1 day'");
  await tx.query("insert into analytics_google_states (state, user_id, product) values ($1, $2, $3)", [state, tx.actor.userId, product]);
  return state;
}

/** Google Analytics' own claim: refuses a Search Console state. */
export async function claimGaState(tx: OrgTx, state: string): Promise<ProviderApp> {
  const claimed = await claimGoogleState(tx, state);
  if (claimed.product !== "analytics") throw new ValidationError("That sign-in link was for another connection. Start connecting again.");
  return claimed.app;
}

export type GaSignIn = { tokens: Tokens; email: string };

/** Exchanges the code and finds the Google account's address (network, no transaction). */
export async function fetchGaSignIn(app: ProviderApp, code: string, origin: string): Promise<GaSignIn> {
  const tokens = await exchangeCode("google", app, code, redirectUri(origin));
  if (!tokens.refreshToken) throw new ValidationError("The sign-in didn't allow offline access, so Tohyee can't load every night. Try connecting again.");
  // Google lets people untick a permission; without reading Analytics there's nothing to load.
  if (tokens.scope && !tokens.scope.split(/\s+/).includes(GA_READ_SCOPE)) {
    throw new ValidationError("The sign-in didn't allow reading Google Analytics. Connect again and tick the box that lets Tohyee see your Google Analytics data.");
  }
  const email = (await googleAccountAddress(tokens.accessToken)).toLowerCase();
  return { tokens, email };
}

/** Stores the sign-in (tokens encrypted). Connecting again keeps the property and settings. */
export async function saveGaSignIn(tx: OrgTx, signIn: GaSignIn, now = new Date()): Promise<GaConnection> {
  await requireAnalytics(tx);
  const values = [
    signIn.email,
    encryptSecret(signIn.tokens.refreshToken!),
    encryptSecret(signIn.tokens.accessToken),
    new Date(now.getTime() + signIn.tokens.expiresInSeconds * 1000).toISOString(),
    tx.actor.email,
  ];
  await tx.query(
    `insert into analytics_google_connections (id, google_email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, connected_by_email)
     values (true, $1, $2, $3, $4, $5)
     on conflict (id) do update set google_email = excluded.google_email, refresh_token_ciphertext = excluded.refresh_token_ciphertext,
            access_token_ciphertext = excluded.access_token_ciphertext, access_token_expires_at = excluded.access_token_expires_at,
            connected_by_email = excluded.connected_by_email, connected_at = now(), needs_reconnect = false, updated_at = now()`,
    values,
  );
  await writeAuditEvent(tx, { eventType: "analytics.google_connected", entityType: "analytics_google_connection", entityId: "google_analytics", details: { googleEmail: signIn.email } });
  return toConnection((await connectionRow(tx))!, true);
}

// Talking to Google ------------------------------------------------------------------------

let retryDelaysMs = [2_000, 6_000];
/** Tests don't wait between retries. */
export function setGaRetryDelaysForTests(delays: number[] | null): void {
  retryDelaysMs = delays ?? [2_000, 6_000];
}

class GaApiError extends Error {
  constructor(
    readonly status: number,
    readonly googleStatus: string | null,
    readonly detail: string,
    readonly reason: string | null,
  ) {
    super(detail);
  }
}

/** What went wrong, in words an admin can act on (GA6, GA7). */
function gaProblem(error: GaApiError, api: "Data" | "Admin"): Error {
  const google = error.detail ? ` Google said: ${error.detail.slice(0, 300)}` : "";
  if (error.status === 429 || error.googleStatus === "RESOURCE_EXHAUSTED") {
    return new UnavailableError(
      "Google Analytics' limit for this property is used up for now (Google allows each property only so much reporting an hour and a day). The data already loaded is kept. Tohyee tries again at the next nightly load, or use Refresh now later.",
    );
  }
  if (error.reason === "SERVICE_DISABLED" || /has not been used in project|is disabled|API has not been used/i.test(error.detail)) {
    return new ConflictError(
      `The Google Analytics ${api} API isn't turned on in the Google Cloud project of this organisation's Google app. An admin needs to enable it in Google Cloud (APIs & Services › Library), then try again.${google}`,
    );
  }
  if (error.status === 401) return new ConflictError("Google didn't accept the sign-in. Connect Google Analytics again.");
  if (error.status === 403) return new ConflictError(`Google says this Google account can't read that Google Analytics property.${google}`);
  if (error.status >= 500) return new UnavailableError(`Google Analytics isn't answering just now. The data already loaded is kept; try again later.${google}`);
  return new ValidationError(`Google Analytics refused the request (${error.status}).${google}`);
}

async function gaRequest<T>(url: string, token: string, body?: unknown): Promise<T> {
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
      throw new UnavailableError(`Couldn't reach Google Analytics: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.ok) {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ValidationError("Google Analytics sent an answer Tohyee can't read.");
      return parsed as T;
    }
    const failure = (parsed as { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } } | null)?.error;
    const error = new GaApiError(
      response.status,
      typeof failure?.status === "string" ? failure.status : null,
      typeof failure?.message === "string" ? failure.message : text.slice(0, 300),
      failure?.details?.find((entry) => typeof entry?.reason === "string")?.reason ?? null,
    );
    // Quota (429) isn't retried: it's per hour and per day, so waiting seconds won't help (Google's quota page).
    if ((response.status === 500 || response.status === 503) && attempt < retryDelaysMs.length) {
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
    if (!row) throw new NotFoundError("Google Analytics isn't connected.");
    return { row, app: await googleApp(tx) };
  });
}

/** A current access token, refreshed (and stored) when it's about to run out. Google refusing the sign-in marks it for reconnecting (GA7). */
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
        tx.query("update analytics_google_connections set needs_reconnect = true, access_token_ciphertext = null, updated_at = now() where id = true"),
      );
      throw new ConflictError(reconnectMessage);
    }
    throw error;
  }
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query(
      `update analytics_google_connections set access_token_ciphertext = $1, access_token_expires_at = $2,
              refresh_token_ciphertext = coalesce($3, refresh_token_ciphertext), updated_at = now() where id = true`,
      [
        encryptSecret(refreshed.accessToken),
        new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString(),
        refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : null,
      ],
    ),
  );
  return refreshed.accessToken;
}

const reconnectMessage =
  "Google no longer accepts this Google Analytics sign-in (it ran out or was withdrawn). An admin needs to connect again. While the organisation's Google app is in Testing, Google ends sign-ins after 7 days.";

// Choosing the property (GA2) ----------------------------------------------------------------

type AccountSummaries = {
  accountSummaries?: Array<{ displayName?: string; propertySummaries?: Array<{ property?: string; displayName?: string; propertyType?: string }> }>;
  nextPageToken?: string;
};

/** The GA4 properties the connected Google account can see (Admin API accountSummaries), by account then name. */
export async function listGaProperties(organisation: OrganisationRecord, actor: Actor): Promise<GaProperty[]> {
  const { row, app } = await loadConnection(organisation, actor);
  const token = await accessToken(organisation, actor, row, app);
  const properties: GaProperty[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({ pageSize: "200" });
    if (pageToken) params.set("pageToken", pageToken);
    let result: AccountSummaries;
    try {
      result = await gaRequest<AccountSummaries>(`${ADMIN_API}/accountSummaries?${params}`, token);
    } catch (error) {
      throw error instanceof GaApiError ? gaProblem(error, "Admin") : error;
    }
    for (const account of result.accountSummaries ?? []) {
      for (const property of account.propertySummaries ?? []) {
        const id = /^properties\/(\d{1,20})$/.exec(property.property ?? "")?.[1];
        if (!id) continue;
        properties.push({ id, name: (property.displayName ?? `Property ${id}`).slice(0, 200), account: (account.displayName ?? "").slice(0, 200) });
      }
    }
    pageToken = result.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return properties.sort((a, b) => a.account.localeCompare(b.account) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Chooses the property and how it loads (GA2, GA5). `available` is what
 * Google listed just now, needed only when the property changes. Returns
 * whether the property changed: then the old property's tables are dropped
 * by the caller once this commits.
 */
export async function saveGaSettings(
  tx: OrgTx,
  input: { propertyId?: unknown; historyMonths?: unknown; reloadDaily?: unknown },
  available: GaProperty[] | null,
): Promise<{ connection: GaConnection; propertyChanged: boolean }> {
  await requireAnalytics(tx);
  const row = await connectionRow(tx, true);
  if (!row) throw new NotFoundError("Google Analytics isn't connected.");
  let property: GaProperty | null = null;
  if (input.propertyId !== undefined && input.propertyId !== row.property_id) {
    const id = typeof input.propertyId === "string" ? input.propertyId : "";
    property = available?.find((entry) => entry.id === id) ?? null;
    if (!property) throw new ValidationError("That property isn't one this Google account can see. Open the list again.");
  }
  let months = row.history_months;
  if (input.historyMonths !== undefined) {
    const value = typeof input.historyMonths === "number" ? input.historyMonths : Number(input.historyMonths);
    if (!Number.isInteger(value) || value < 1 || value > GA_MAX_HISTORY_MONTHS) throw new ValidationError(`Load between 1 and ${GA_MAX_HISTORY_MONTHS} months of history.`);
    months = value;
  }
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? row.reload_daily : (input.reloadDaily as boolean);
  if (!property && !row.property_id) throw new ValidationError("Choose the Google Analytics property to load.");
  await tx.query(
    `update analytics_google_connections set property_id = coalesce($1, property_id), property_name = coalesce($2, property_name),
            account_name = case when $1::text is null then account_name else $3 end,
            currency_code = case when $1::text is null then currency_code end, time_zone = case when $1::text is null then time_zone end,
            history_months = $4, reload_daily = $5, updated_at = now() where id = true`,
    [property?.id ?? null, property?.name ?? null, property?.account ?? null, months, reloadDaily],
  );
  await writeAuditEvent(tx, {
    eventType: "analytics.google_settings_saved",
    entityType: "analytics_google_connection",
    entityId: "google_analytics",
    details: { propertyId: property?.id ?? row.property_id, historyMonths: months, reloadDaily },
  });
  return { connection: toConnection((await connectionRow(tx))!, true), propertyChanged: Boolean(property && row.property_id) };
}

/** Drops the Google Analytics tables (after a property change or disconnecting). */
export function dropGaTables(organisationId: string): Promise<string[]> {
  return dropTablesWithPrefix(organisationId, GA_TABLE_PREFIX);
}

// Loading (GA3-GA6) --------------------------------------------------------------------------

/** Every page of one report (offset and limit), up to the row limit. */
async function readReport(token: string, propertyId: string, report: GaReport, startDate: string) {
  const rows: Array<Array<string | null>> = [];
  let metadata: GaReportResponse["metadata"] = undefined;
  for (let offset = 0; ; ) {
    let page: GaReportResponse;
    try {
      page = await gaRequest<GaReportResponse>(`${DATA_API}/properties/${propertyId}:runReport`, token, gaReportRequest(report, startDate, offset));
    } catch (error) {
      throw error instanceof GaApiError ? gaProblem(error, "Data") : error;
    }
    metadata ??= page.metadata;
    const total = Number(page.rowCount ?? 0);
    if (total > GA_MAX_ROWS_PER_REPORT) {
      throw new ValidationError(`${report.label} has ${total.toLocaleString("en-NZ")} rows, more than Tohyee loads (${GA_MAX_ROWS_PER_REPORT.toLocaleString("en-NZ")}). Load fewer months.`);
    }
    const mapped = gaRows(report, page);
    rows.push(...mapped);
    // Google can send fewer rows than asked for, so the next page starts after what came.
    offset += mapped.length;
    if (mapped.length === 0 || offset >= total) break;
  }
  return { rows, metadata };
}

/**
 * Loads the chosen property now (nightly, or Refresh now). The record of the
 * load is written before and after; Google is read with no transaction open,
 * every report first, and the tables are swapped in together only when all
 * of them have arrived, so a failed load leaves the last good copy (GA4).
 */
export async function refreshGa(organisation: OrganisationRecord, actor: Actor, trigger: "schedule" | "manual", today = todayIsoDate()): Promise<LoadRun> {
  const started = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx);
    if (!row) throw new NotFoundError("Google Analytics isn't connected.");
    if (!row.property_id) throw new ConflictError("Choose the Google Analytics property to load first.");
    const busy = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [
      GA_LOAD_TABLE_NAME,
    ]);
    if (busy.rows.length > 0) throw new ConflictError("Google Analytics is already loading.");
    const run = await tx.query<{ id: string }>(
      `insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger, requested_by_email)
       values (null, $1, $2, $3, $4, $5) returning id::text`,
      [GA_SOURCE_NAME, GA_LOAD_TABLE_NAME, `${row.property_name ?? "Property"} (GA4 property ${row.property_id})`, trigger, trigger === "manual" ? actor.email : null],
    );
    return { runId: run.rows[0].id, propertyId: row.property_id, months: row.history_months };
  });

  const began = performance.now();
  let rows: number | null = null;
  let error: string | null = null;
  let metadata: GaReportResponse["metadata"] = undefined;
  try {
    const { row, app } = await loadConnection(organisation, actor);
    const token = await accessToken(organisation, actor, row, app);
    const startDate = gaHistoryStart(today, started.months);
    const tables: TableCopy[] = [];
    for (const report of GA_REPORTS) {
      const read = await readReport(token, started.propertyId, report, startDate);
      metadata ??= read.metadata;
      tables.push({ name: report.table, columns: gaTableColumns(report), rows: read.rows });
    }
    rows = await replaceTableSet(organisation.id, GA_TABLE_PREFIX, tables, "The Google Analytics data couldn't be loaded");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const milliseconds = Math.round(performance.now() - began);

  const run = await withOrganisationTransaction(organisation, actor, async (tx) => {
    if (!error && metadata) {
      await tx.query("update analytics_google_connections set currency_code = $1, time_zone = $2, updated_at = now() where id = true", [
        typeof metadata.currencyCode === "string" ? metadata.currencyCode.slice(0, 10) : null,
        typeof metadata.timeZone === "string" ? metadata.timeZone.slice(0, 64) : null,
      ]);
    }
    const result = await tx.query<RunRow>(
      `update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5 where id = $1 returning ${RUN_COLUMNS}`,
      [started.runId, error ? "failed" : "ok", rows === null ? null : String(rows), milliseconds, error],
    );
    return toRun(result.rows[0]);
  });
  if (run.status === "ok") {
    try {
      await rebuildShapedTablesForTables(organisation, actor, GA_REPORTS.map((report) => report.table), trigger);
    } catch (caught) {
      console.warn("[tohyee] Shaped tables after loading Google Analytics:", caught instanceof Error ? caught.message : caught);
    }
  }
  return run;
}

/** Whether the nightly load should consider Google Analytics at all: a property chosen, nightly on, and the sign-in still good. */
export async function gaLoadsNightly(tx: OrgTx): Promise<boolean> {
  const row = await connectionRow(tx);
  return Boolean(row && row.property_id && row.reload_daily && !row.needs_reconnect);
}

// Disconnecting (GA8) ------------------------------------------------------------------------

/**
 * Disconnects: deletes the tokens and the connection, then (after it
 * commits) asks Google to withdraw the sign-in and drops every
 * `google_analytics_*` table. The load history stays, like a removed source.
 * Refused while a shaped table is built from the data, or a load is running.
 */
export async function disconnectGa(organisation: OrganisationRecord, actor: Actor): Promise<void> {
  const refreshToken = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx, true);
    if (!row) throw new NotFoundError("Google Analytics isn't connected.");
    const running = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [
      GA_LOAD_TABLE_NAME,
    ]);
    if (running.rows.length > 0) throw new ConflictError("Google Analytics is loading. Try again when it's finished.");
    const users = new Set<string>();
    for (const report of GA_REPORTS) for (const name of await shapesUsing(tx, report.table)) users.add(name);
    if (users.size > 0) {
      const list = [...users];
      throw new ConflictError(`The shaped table${list.length === 1 ? "" : "s"} ${list.join(", ")} ${list.length === 1 ? "uses" : "use"} Google Analytics data. Change or remove ${list.length === 1 ? "it" : "them"} first.`);
    }
    await tx.query("delete from analytics_google_connections where id = true");
    await tx.query("delete from analytics_google_states where product = 'analytics'");
    await writeAuditEvent(tx, { eventType: "analytics.google_disconnected", entityType: "analytics_google_connection", entityId: "google_analytics", details: { propertyId: row.property_id } });
    // Google may withdraw everything the account allowed this Google app, so not while Search Console uses the same account (decision 1188).
    const shared = await tx.query("select 1 from analytics_search_console_connections where google_email = $1", [row.google_email]);
    return shared.rows.length ? null : decryptSecret(row.refresh_token_ciphertext);
  });
  // Withdrawing at Google is a courtesy: the token is already deleted here, so a failure doesn't matter.
  if (refreshToken) {
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
  await dropGaTables(organisation.id);
}

