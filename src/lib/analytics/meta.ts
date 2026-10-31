import { randomBytes } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { type DatedTableCopy, dropTablesWithPrefix, mergeTableWindows, tablesWithPrefix } from "@/lib/analytics/engine";
import {
  META_ADS_CHUNK_DAYS,
  META_ADS_FIELDS,
  META_ADS_HISTORY_MONTHS,
  META_ADS_PERMISSION,
  META_ADS_SETTLE_DAYS,
  META_CALLBACK_PATH,
  META_GRAPH,
  META_INSTAGRAM_FOLLOWS,
  META_INSTAGRAM_HISTORY_DAYS,
  META_INSTAGRAM_METRICS,
  META_INSTAGRAM_PERMISSIONS,
  META_LOAD_TABLE_NAME,
  META_MAX_POSTS,
  META_PAGE_CHUNK_DAYS,
  META_PAGE_HISTORY_DAYS,
  META_PAGE_METRICS,
  META_PERMISSION_TEXT,
  META_POST_METRICS,
  META_POST_REFRESH_DAYS,
  META_SETTLE_DAYS,
  META_SOURCE_NAME,
  META_TABLE_PREFIX,
  META_TABLES,
  type MetaAdsRow,
  type MetaFailure,
  type MetaInsight,
  type MetaMedia,
  type MetaPagePost,
  type MetaPart,
  type MetaPermissionRow,
  type MetaWindow,
  metaAddDays,
  metaAdsRow,
  metaAuthorisationUrl,
  metaChunks,
  metaDays,
  metaInstagramDayRow,
  metaInstagramPostRow,
  metaMediaMetrics,
  metaMidnight,
  metaMonthsBefore,
  metaPageDailyRows,
  metaPagePostRow,
  metaPermissions,
  metaPostedDay,
  metaProblemKind,
  metaProblemText,
  metaReadAllPages,
  metaReconnectReason,
  metaTable,
  metaTableColumns,
  metaToday,
  metaWindow,
  missingPagePermissions,
} from "@/lib/analytics/meta-reports";
import { rebuildShapedTablesForTables, shapesUsing } from "@/lib/analytics/shaped-tables";
import { type LoadRun, requireAnalytics, RUN_COLUMNS, type RunRow, toRun } from "@/lib/analytics/sources";
import { providerFetch } from "@/lib/crm/mail/providers";
import { isoDateAt } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";

/*
 * Meta (a Facebook Page, its Instagram professional account and,
 * optionally, an ad account) as an Analytics data source (#516, decisions
 * 1190-1209, examples META1-META10), built like Google Search Console
 * (1180-1189). An admin saves the organisation's own Meta app, signs in
 * with Facebook asking only for read permissions, chooses the Page (its
 * Instagram account comes with it) and maybe an ad account, and Tohyee
 * loads `meta_*` tables nightly and by Refresh now. Tokens are stored
 * encrypted. Network calls happen outside database transactions.
 */

const STATE_MINUTES = 15;
const TIMEOUT_MS = 60_000;
/** A user token this close to ending gets a warning on the card. */
const WARN_DAYS = 14;

export type MetaAppSettings = { appId: string | null; secretSaved: boolean; configId: string | null };
export type MetaConnection = {
  /** The Facebook person who signed in; only shown to admins and owners. */
  facebookName: string | null;
  pageId: string | null;
  pageName: string | null;
  instagramId: string | null;
  instagramUsername: string | null;
  adAccountId: string | null;
  adAccountName: string | null;
  adCurrency: string | null;
  adTimeZone: string | null;
  canReadAds: boolean;
  declined: string[];
  reloadDaily: boolean;
  needsReconnect: boolean;
  reconnectReason: string | null;
  /** When the user sign-in ends (ads and listing Pages need it); the Page's own access doesn't end on a date. */
  signInEndsAt: string | null;
  signInEndsSoon: boolean;
  facebookLoadedThrough: string | null;
  instagramLoadedThrough: string | null;
  adsLoadedThrough: string | null;
  connectedByEmail: string;
  connectedAt: string;
};
export type MetaStatus = { appReady: boolean; connection: MetaConnection | null; lastLoad: LoadRun | null; callbackPath: string; tables: string[] };
export type MetaPage = { id: string; name: string; canAnalyse: boolean; instagram: { id: string; username: string; followers: number | null } | null };
export type MetaAdAccount = { id: string; name: string; currency: string; timeZone: string; active: boolean };
export type MetaAccounts = { pages: MetaPage[]; adAccounts: MetaAdAccount[]; canReadAds: boolean };

type AppRow = { app_id: string; app_secret_ciphertext: string; config_id: string | null };
type ConnectionRow = {
  facebook_user_id: string;
  facebook_user_name: string | null;
  user_token_ciphertext: string;
  user_token_expires_at: Date | null;
  data_access_expires_at: Date | null;
  granted_permissions: string;
  declined_permissions: string;
  page_id: string | null;
  page_name: string | null;
  page_token_ciphertext: string | null;
  instagram_id: string | null;
  instagram_username: string | null;
  ad_account_id: string | null;
  ad_account_name: string | null;
  ad_currency: string | null;
  ad_time_zone: string | null;
  reload_daily: boolean;
  needs_reconnect: boolean;
  reconnect_reason: string | null;
  facebook_loaded_through: string | null;
  instagram_loaded_through: string | null;
  ads_loaded_through: string | null;
  connected_by_email: string;
  connected_at: Date;
};

const COLUMNS = `facebook_user_id, facebook_user_name, user_token_ciphertext, user_token_expires_at, data_access_expires_at, granted_permissions, declined_permissions,
  page_id, page_name, page_token_ciphertext, instagram_id, instagram_username, ad_account_id, ad_account_name, ad_currency, ad_time_zone, reload_daily,
  needs_reconnect, reconnect_reason, facebook_loaded_through::text, instagram_loaded_through::text, ads_loaded_through::text, connected_by_email, connected_at`;

async function connectionRow(tx: OrgTx, lock = false): Promise<ConnectionRow | null> {
  const result = await tx.query<ConnectionRow>(`select ${COLUMNS} from analytics_meta_connections where id = true${lock ? " for update" : ""}`);
  return result.rows[0] ?? null;
}

const list = (text: string) => text.split(",").filter(Boolean);

function signInEnd(row: ConnectionRow): Date | null {
  const dates = [row.user_token_expires_at, row.data_access_expires_at].filter((value): value is Date => value !== null).map((value) => new Date(value));
  return dates.length ? new Date(Math.min(...dates.map((value) => value.getTime()))) : null;
}

function toConnection(row: ConnectionRow, isAdmin: boolean, now = new Date()): MetaConnection {
  const ends = signInEnd(row);
  return {
    facebookName: isAdmin ? row.facebook_user_name : null,
    pageId: row.page_id,
    pageName: row.page_name,
    instagramId: row.instagram_id,
    instagramUsername: row.instagram_username,
    adAccountId: row.ad_account_id,
    adAccountName: row.ad_account_name,
    adCurrency: row.ad_currency,
    adTimeZone: row.ad_time_zone,
    canReadAds: list(row.granted_permissions).includes(META_ADS_PERMISSION),
    declined: list(row.declined_permissions),
    reloadDaily: row.reload_daily,
    needsReconnect: row.needs_reconnect,
    reconnectReason: row.reconnect_reason,
    signInEndsAt: ends ? ends.toISOString() : null,
    signInEndsSoon: Boolean(ends && ends.getTime() - now.getTime() < WARN_DAYS * 86_400_000),
    facebookLoadedThrough: row.facebook_loaded_through,
    instagramLoadedThrough: row.instagram_loaded_through,
    adsLoadedThrough: row.ads_loaded_through,
    connectedByEmail: row.connected_by_email,
    connectedAt: new Date(row.connected_at).toISOString(),
  };
}

/** The latest Meta load, or null. */
export async function lastMetaRun(tx: OrgTx): Promise<LoadRun | null> {
  const result = await tx.query<RunRow>(
    `select ${RUN_COLUMNS} from analytics_load_runs where source_id is null and table_name = $1 order by started_at desc, id desc limit 1`,
    [META_LOAD_TABLE_NAME],
  );
  return result.rows[0] ? toRun(result.rows[0]) : null;
}

/** Whether the app is saved, the connection (if any), its last load and the tables. Anyone in the organisation; the Facebook name only for admins. */
export async function getMetaStatus(tx: OrgTx, isAdmin: boolean, now = new Date()): Promise<MetaStatus> {
  await requireAnalytics(tx);
  const row = await connectionRow(tx);
  const app = await appRow(tx);
  return {
    appReady: Boolean(app),
    connection: row ? toConnection(row, isAdmin, now) : null,
    lastLoad: await lastMetaRun(tx),
    callbackPath: META_CALLBACK_PATH,
    tables: META_TABLES.map((table) => table.table),
  };
}

function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${META_CALLBACK_PATH}`;
}

// The organisation's Meta app (decision 1191) ---------------------------------------------------

async function appRow(tx: OrgTx): Promise<AppRow | null> {
  const result = await tx.query<AppRow>("select app_id, app_secret_ciphertext, config_id from analytics_meta_apps where id = true");
  return result.rows[0] ?? null;
}

/** The saved app, without its secret. Admins and owners (the route checks). */
export async function getMetaApp(tx: OrgTx): Promise<MetaAppSettings> {
  await requireAnalytics(tx);
  const row = await appRow(tx);
  return { appId: row?.app_id ?? null, secretSaved: Boolean(row), configId: row?.config_id ?? null };
}

/** Saves the app ID, secret (kept when left blank) and Facebook Login for Business configuration ID. */
export async function saveMetaApp(tx: OrgTx, input: { appId?: unknown; appSecret?: unknown; configId?: unknown }): Promise<MetaAppSettings> {
  await requireAnalytics(tx);
  if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store the Meta app's secret.");
  const appId = typeof input.appId === "string" ? input.appId.trim() : "";
  if (!/^[0-9]{5,20}$/.test(appId)) throw new ValidationError("The App ID is the number at the top of the app's dashboard in Meta for Developers (only digits).");
  const secret = typeof input.appSecret === "string" ? input.appSecret.trim() : "";
  if (secret && !/^[0-9a-f]{32}$/i.test(secret)) throw new ValidationError("The App secret is 32 letters and numbers, from App settings › Basic › App secret (choose Show).");
  const configText = typeof input.configId === "string" ? input.configId.trim() : "";
  if (configText && !/^[0-9]{5,20}$/.test(configText)) throw new ValidationError("The Configuration ID is only digits, from Facebook Login for Business › Configurations.");
  const current = await appRow(tx);
  if (!secret && (!current || current.app_id !== appId)) throw new ValidationError("Enter the App secret.");
  await tx.query(
    `insert into analytics_meta_apps (id, app_id, app_secret_ciphertext, config_id, updated_by_email) values (true, $1, $2, $3, $4)
     on conflict (id) do update set app_id = excluded.app_id, app_secret_ciphertext = excluded.app_secret_ciphertext, config_id = excluded.config_id,
            updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [appId, secret ? encryptSecret(secret) : current!.app_secret_ciphertext, configText || null, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "analytics.meta_app_saved", entityType: "analytics_meta_app", entityId: "meta", details: { appId, secretChanged: Boolean(secret), configId: configText || null } });
  return getMetaApp(tx);
}

type MetaApp = { appId: string; secret: string; configId: string | null };

async function metaApp(tx: OrgTx): Promise<MetaApp> {
  const row = await appRow(tx);
  if (!row) throw new ConflictError("Meta isn't set up yet. An admin needs to save the Meta app's App ID and secret first (Set up Meta).");
  return { appId: row.app_id, secret: decryptSecret(row.app_secret_ciphertext), configId: row.config_id };
}

// Connecting (META1) -------------------------------------------------------------------------

/** Meta's sign-in address, with a one-time state tied to this admin. The route checks the role. */
export async function startMetaConnect(tx: OrgTx, origin: string, options: { withAds?: unknown } = {}): Promise<{ url: string }> {
  await requireAnalytics(tx);
  if (!tx.actor.userId) throw new ForbiddenError("Sign in to connect Meta.");
  if (!secretsAvailable()) throw new UnavailableError("The server has no TOHYEE_SECRET_KEY, so it can't store Meta's sign-in.");
  const app = await metaApp(tx);
  const withAds = options.withAds === true;
  const state = `${tx.organisationId}.${randomBytes(24).toString("base64url")}`;
  await tx.query("delete from analytics_meta_states where created_at < now() - interval '1 day'");
  await tx.query("insert into analytics_meta_states (state, user_id, with_ads) values ($1, $2, $3)", [state, tx.actor.userId, withAds]);
  return { url: metaAuthorisationUrl({ appId: app.appId, redirectUri: redirectUri(origin), state, configId: app.configId, withAds }) };
}

/** Checks a sign-in's state (unused, under 15 minutes old, the same admin) and marks it used, before the code is exchanged. */
export async function claimMetaState(tx: OrgTx, state: string): Promise<{ app: MetaApp; withAds: boolean }> {
  await requireAnalytics(tx);
  const found = await tx.query<{ user_id: string; fresh: boolean; used_at: string | null; with_ads: boolean }>(
    "select user_id, created_at > now() - make_interval(mins => $2) as fresh, used_at, with_ads from analytics_meta_states where state = $1 for update",
    [state, STATE_MINUTES],
  );
  const row = found.rows[0];
  if (!row || row.used_at || !row.fresh || row.user_id !== tx.actor.userId) {
    throw new ValidationError("That sign-in link has expired or was already used. Start connecting again.");
  }
  await tx.query("update analytics_meta_states set used_at = now() where state = $1", [state]);
  return { app: await metaApp(tx), withAds: row.with_ads };
}

type PageWithToken = MetaPage & { token: string | null };
export type MetaSignIn = {
  userId: string;
  name: string | null;
  token: string;
  expiresAt: string | null;
  dataAccessExpiresAt: string | null;
  granted: string[];
  declined: string[];
  pages: PageWithToken[];
};

/**
 * Exchanges the code, makes the token long-lived, finds who signed in,
 * what they allowed and their Pages with each Page's own token (network,
 * no transaction). Refused when the Page permissions weren't allowed.
 */
export async function fetchMetaSignIn(app: MetaApp, code: string, origin: string, now = new Date()): Promise<MetaSignIn> {
  const short = await graph<{ access_token?: string }>(
    `${META_GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: app.appId, client_secret: app.secret, redirect_uri: redirectUri(origin), code })}`,
    "the sign-in",
  );
  if (typeof short.access_token !== "string") throw new ValidationError("Meta didn't return a sign-in. Try connecting again.");
  // A long-lived user token (about 60 days); Pages listed with it get tokens with no fixed end.
  const long = await graph<{ access_token?: string; expires_in?: number }>(
    `${META_GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.secret, fb_exchange_token: short.access_token })}`,
    "the sign-in",
  );
  if (typeof long.access_token !== "string") throw new ValidationError("Meta didn't make the sign-in long-lived. Try connecting again.");
  const token = long.access_token;
  const me = await graph<{ id?: string; name?: string }>(`${META_GRAPH}/me?${new URLSearchParams({ fields: "id,name", access_token: token })}`, "your Facebook account");
  if (typeof me.id !== "string" || !/^[0-9]{1,30}$/.test(me.id)) throw new ValidationError("Meta didn't say who signed in. Try connecting again.");
  const permissions = await graph<{ data?: MetaPermissionRow[] }>(`${META_GRAPH}/me/permissions?${new URLSearchParams({ access_token: token })}`, "your permissions");
  const { granted, declined } = metaPermissions(permissions.data ?? []);
  const missing = missingPagePermissions(granted);
  if (missing.length) {
    throw new ValidationError(`The sign-in didn't allow Tohyee to ${missing.map((name) => META_PERMISSION_TEXT[name] ?? name).join(", ")}. Connect again and leave those ticked.`);
  }
  const debug = await debugToken(app, token);
  const expiresAt = debug.expiresAt ?? (typeof long.expires_in === "number" ? new Date(now.getTime() + long.expires_in * 1000).toISOString() : null);
  const pages = await readPages(token);
  return { userId: me.id, name: typeof me.name === "string" ? me.name.slice(0, 200) : null, token, expiresAt, dataAccessExpiresAt: debug.dataAccessExpiresAt, granted, declined, pages };
}

async function debugToken(app: MetaApp, token: string): Promise<{ valid: boolean; expiresAt: string | null; dataAccessExpiresAt: string | null; scopes: string[] }> {
  const answer = await graph<{ data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] } }>(
    `${META_GRAPH}/debug_token?${new URLSearchParams({ input_token: token, access_token: `${app.appId}|${app.secret}` })}`,
    "the sign-in",
  );
  const data = answer.data ?? {};
  const when = (seconds: number | undefined) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);
  return { valid: data.is_valid === true, expiresAt: when(data.expires_at), dataAccessExpiresAt: when(data.data_access_expires_at), scopes: Array.isArray(data.scopes) ? data.scopes.filter((scope) => typeof scope === "string") : [] };
}

type PageEntry = { id?: string; name?: string; access_token?: string; tasks?: string[]; instagram_business_account?: { id?: string; username?: string; followers_count?: number } };

async function readPages(userToken: string): Promise<PageWithToken[]> {
  const entries = await metaReadAllPages<PageEntry>((after) =>
    graph(
      `${META_GRAPH}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,tasks,instagram_business_account{id,username,followers_count}", limit: "100", access_token: userToken, ...(after ? { after } : {}) })}`,
      "your Pages",
    ),
  );
  const pages: PageWithToken[] = [];
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !/^[0-9]{1,30}$/.test(entry.id)) continue;
    const ig = entry.instagram_business_account;
    pages.push({
      id: entry.id,
      name: (entry.name ?? `Page ${entry.id}`).slice(0, 200),
      // Reading insights needs the Analyse task (or a full role) on the Page.
      canAnalyse: !Array.isArray(entry.tasks) || entry.tasks.includes("ANALYZE") || entry.tasks.includes("MANAGE"),
      instagram: ig && typeof ig.id === "string" && /^[0-9]{1,30}$/.test(ig.id) ? { id: ig.id, username: (ig.username ?? "").slice(0, 100), followers: typeof ig.followers_count === "number" ? ig.followers_count : null } : null,
      token: typeof entry.access_token === "string" ? entry.access_token : null,
    });
  }
  return pages.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Stores the sign-in (tokens encrypted). Connecting again keeps the
 * choices and what's loaded, and takes a fresh token for the chosen Page;
 * if this person can't see that Page, the Page has to be chosen again.
 */
export async function saveMetaSignIn(tx: OrgTx, signIn: MetaSignIn): Promise<MetaConnection> {
  await requireAnalytics(tx);
  const current = await connectionRow(tx, true);
  const page = current?.page_id ? signIn.pages.find((entry) => entry.id === current.page_id && entry.token) : undefined;
  const keepPage = Boolean(page);
  const canReadAds = signIn.granted.includes(META_ADS_PERMISSION);
  await tx.query(
    `insert into analytics_meta_connections (id, facebook_user_id, facebook_user_name, user_token_ciphertext, user_token_expires_at, data_access_expires_at,
            granted_permissions, declined_permissions, connected_by_email)
     values (true, $1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do update set facebook_user_id = excluded.facebook_user_id, facebook_user_name = excluded.facebook_user_name,
            user_token_ciphertext = excluded.user_token_ciphertext, user_token_expires_at = excluded.user_token_expires_at,
            data_access_expires_at = excluded.data_access_expires_at, granted_permissions = excluded.granted_permissions,
            declined_permissions = excluded.declined_permissions, connected_by_email = excluded.connected_by_email, connected_at = now(),
            needs_reconnect = false, reconnect_reason = null, updated_at = now()`,
    [signIn.userId, signIn.name, encryptSecret(signIn.token), signIn.expiresAt, signIn.dataAccessExpiresAt, signIn.granted.join(","), signIn.declined.join(","), tx.actor.email],
  );
  if (current?.page_id) {
    if (keepPage) {
      await tx.query("update analytics_meta_connections set page_token_ciphertext = $1, page_name = $2 where id = true", [encryptSecret(page!.token!), page!.name]);
    } else {
      // The Page isn't one this person can see: choose again (what's loaded stays until then).
      await tx.query("update analytics_meta_connections set page_id = null, page_name = null, page_token_ciphertext = null, instagram_id = null, instagram_username = null where id = true");
    }
  }
  if (!canReadAds) await tx.query("update analytics_meta_connections set ad_account_id = null, ad_account_name = null, ad_currency = null, ad_time_zone = null where id = true");
  await writeAuditEvent(tx, { eventType: "analytics.meta_connected", entityType: "analytics_meta_connection", entityId: "meta", details: { facebookUserId: signIn.userId, granted: signIn.granted, declined: signIn.declined } });
  return toConnection((await connectionRow(tx))!, true);
}

// Talking to Meta ----------------------------------------------------------------------------

let retryDelaysMs = [10_000, 30_000, 90_000];
/** Tests don't wait between retries. */
export function setMetaRetryDelaysForTests(delays: number[] | null): void {
  retryDelaysMs = delays ?? [10_000, 30_000, 90_000];
}

class MetaApiError extends Error {
  constructor(
    readonly failure: MetaFailure,
    readonly what: string,
  ) {
    super(metaProblemText(failure, what));
  }
  get kind() {
    return metaProblemKind(this.failure);
  }
}

/** The longest wait Meta asks for in its usage headers, in minutes. */
function regainMinutes(headers: Headers): number | null {
  const text = headers.get("x-business-use-case-usage");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
    const minutes = Object.values(parsed)
      .flat()
      .map((entry) => Number(entry?.estimated_time_to_regain_access ?? 0))
      .filter((value) => Number.isFinite(value));
    const most = Math.max(0, ...minutes);
    return most > 0 ? Math.min(most, 24 * 60) : null;
  } catch {
    return null;
  }
}

/**
 * One GET. Rate limits (codes 4, 17, 32, 613 and the business ones) and
 * passing troubles are tried again after 10, 30 and 90 seconds, unless
 * Meta says the wait is longer than two minutes: then Tohyee stops calling,
 * as Meta asks (decision 1199).
 */
async function graph<T>(url: string, what: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await providerFetch(url, { method: "GET", headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      if (attempt < retryDelaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        continue;
      }
      throw new UnavailableError(`Couldn't reach Meta: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.ok && parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("error" in parsed)) return parsed as T;
    if (response.ok && (!parsed || typeof parsed !== "object")) throw new ValidationError("Meta sent an answer Tohyee can't read.");
    const error = (parsed as { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } } | null)?.error;
    const failure: MetaFailure = {
      status: response.status,
      code: typeof error?.code === "number" ? error.code : null,
      subcode: typeof error?.error_subcode === "number" ? error.error_subcode : null,
      message: typeof error?.error_user_msg === "string" ? error.error_user_msg : typeof error?.message === "string" ? error.message : text.slice(0, 300),
      regainMinutes: regainMinutes(response.headers),
    };
    const kind = metaProblemKind(failure);
    const waitTooLong = failure.regainMinutes !== null && failure.regainMinutes > 2;
    if ((kind === "busy" || (kind === "limit" && !waitTooLong)) && attempt < retryDelaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      continue;
    }
    throw new MetaApiError(failure, what);
  }
}

const reconnectText = (reason: string | null) =>
  `Meta no longer accepts this sign-in${reason ? ` (${reason})` : ""}. An admin needs to connect again: Data sources › Meta › Connect again.`;

/** Meta refused the sign-in: mark it, so nothing loads until an admin connects again (decision 1197). */
async function markReconnect(organisation: OrganisationRecord, actor: Actor, error: MetaApiError): Promise<never> {
  const reason = metaReconnectReason(error.failure.subcode);
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query("update analytics_meta_connections set needs_reconnect = true, reconnect_reason = $1, updated_at = now() where id = true", [reason]),
  );
  throw new ConflictError(reconnectText(reason));
}

async function loadConnection(organisation: OrganisationRecord, actor: Actor): Promise<{ row: ConnectionRow; app: MetaApp }> {
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx);
    if (!row) throw new NotFoundError("Meta isn't connected.");
    return { row, app: await metaApp(tx) };
  });
}

// Choosing what to load (META2) ----------------------------------------------------------------

type AdAccountEntry = { id?: string; name?: string; currency?: string; timezone_name?: string; account_status?: number };

async function readAccounts(row: ConnectionRow): Promise<{ pages: PageWithToken[]; adAccounts: MetaAdAccount[]; canReadAds: boolean }> {
  const token = decryptSecret(row.user_token_ciphertext);
  const pages = await readPages(token);
  const canReadAds = list(row.granted_permissions).includes(META_ADS_PERMISSION);
  const adAccounts: MetaAdAccount[] = [];
  if (canReadAds) {
    const entries = await metaReadAllPages<AdAccountEntry>((after) =>
      graph(`${META_GRAPH}/me/adaccounts?${new URLSearchParams({ fields: "id,name,currency,timezone_name,account_status", limit: "100", access_token: token, ...(after ? { after } : {}) })}`, "your ad accounts"),
    );
    for (const entry of entries) {
      if (typeof entry.id !== "string" || !/^act_[0-9]{1,30}$/.test(entry.id)) continue;
      adAccounts.push({
        id: entry.id,
        name: (entry.name ?? entry.id).slice(0, 200),
        currency: typeof entry.currency === "string" ? entry.currency.slice(0, 10) : "",
        timeZone: typeof entry.timezone_name === "string" ? entry.timezone_name.slice(0, 64) : "",
        // 1 is active (Meta's ad account status); others are disabled, closed or unsettled.
        active: entry.account_status === 1,
      });
    }
    adAccounts.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  return { pages, adAccounts, canReadAds };
}

async function withSignIn<T>(organisation: OrganisationRecord, actor: Actor, work: (row: ConnectionRow, app: MetaApp) => Promise<T>): Promise<T> {
  const { row, app } = await loadConnection(organisation, actor);
  if (row.needs_reconnect) throw new ConflictError(reconnectText(row.reconnect_reason));
  try {
    return await work(row, app);
  } catch (error) {
    if (error instanceof MetaApiError && error.kind === "signin") return markReconnect(organisation, actor, error);
    throw error;
  }
}

/** The Pages (with their Instagram accounts) and ad accounts the signed-in person can see, without tokens. Admins and owners. */
export async function listMetaAccounts(organisation: OrganisationRecord, actor: Actor): Promise<MetaAccounts> {
  const found = await withSignIn(organisation, actor, (row) => readAccounts(row));
  return { pages: found.pages.map((page) => ({ id: page.id, name: page.name, canAnalyse: page.canAnalyse, instagram: page.instagram })), adAccounts: found.adAccounts, canReadAds: found.canReadAds };
}

/** As listMetaAccounts, with each Page's token, for saving a choice (server only). */
export async function availableMetaAccounts(organisation: OrganisationRecord, actor: Actor) {
  return withSignIn(organisation, actor, (row) => readAccounts(row));
}

/**
 * Chooses the Page (its Instagram account comes with it, if linked), maybe
 * an ad account, and nightly loading (META2). `available` is what Meta
 * listed just now. Returns the parts that start again (a different Page or
 * ad account): their tables are dropped by the caller once this commits.
 */
export async function saveMetaChoice(
  tx: OrgTx,
  input: { pageId?: unknown; adAccountId?: unknown; reloadDaily?: unknown },
  available: { pages: PageWithToken[]; adAccounts: MetaAdAccount[]; canReadAds: boolean } | null,
): Promise<{ connection: MetaConnection; startAgain: MetaPart[] }> {
  await requireAnalytics(tx);
  const row = await connectionRow(tx, true);
  if (!row) throw new NotFoundError("Meta isn't connected.");
  let page: PageWithToken | null = null;
  if (input.pageId !== undefined && (input.pageId !== row.page_id || !row.page_token_ciphertext)) {
    page = available?.pages.find((entry) => entry.id === input.pageId) ?? null;
    if (!page) throw new ValidationError("That Page isn't one this Facebook account manages. Open the list again.");
    if (!page.token) throw new ValidationError("Meta didn't give Tohyee access to that Page. Connect again and choose it when Meta asks which Pages to share.");
    if (!page.canAnalyse) throw new ValidationError("Your role on that Page can't see its insights. Ask the Page's admin to give you full control or the Insights task in Meta Business Suite.");
  }
  if (!page && !row.page_id) throw new ValidationError("Choose the Facebook Page to load.");
  let adAccount: MetaAdAccount | null | undefined;
  if (input.adAccountId === null || input.adAccountId === "") adAccount = null;
  else if (input.adAccountId !== undefined && input.adAccountId !== row.ad_account_id) {
    if (!available?.canReadAds) throw new ValidationError("This sign-in can't read ads. Connect again with Also load ads ticked.");
    adAccount = available.adAccounts.find((entry) => entry.id === input.adAccountId) ?? null;
    if (!adAccount) throw new ValidationError("That ad account isn't one this Facebook account can see. Open the list again.");
  }
  if (input.reloadDaily !== undefined && typeof input.reloadDaily !== "boolean") throw new ValidationError("reloadDaily must be true or false.");
  const reloadDaily = input.reloadDaily === undefined ? row.reload_daily : (input.reloadDaily as boolean);
  const startAgain: MetaPart[] = [];
  if (page && page.id !== row.page_id) {
    if (row.facebook_loaded_through) startAgain.push("facebook");
    if (row.instagram_loaded_through && page.instagram?.id !== row.instagram_id) startAgain.push("instagram");
  }
  if (adAccount !== undefined && (adAccount?.id ?? null) !== row.ad_account_id && row.ads_loaded_through) startAgain.push("ads");
  if (page) {
    const instagramChanged = page.instagram?.id !== row.instagram_id;
    await tx.query(
      `update analytics_meta_connections set page_id = $1, page_name = $2, page_token_ciphertext = $3, instagram_id = $4, instagram_username = $5,
              facebook_loaded_through = case when $6 then facebook_loaded_through end, instagram_loaded_through = case when $7 then instagram_loaded_through end where id = true`,
      [page.id, page.name, encryptSecret(page.token!), page.instagram?.id ?? null, page.instagram?.username ?? null, page.id === row.page_id, !instagramChanged],
    );
  }
  if (adAccount !== undefined) {
    await tx.query(
      "update analytics_meta_connections set ad_account_id = $1, ad_account_name = $2, ad_currency = $3, ad_time_zone = $4, ads_loaded_through = case when $5 then ads_loaded_through end where id = true",
      [adAccount?.id ?? null, adAccount?.name ?? null, adAccount?.currency || null, adAccount?.timeZone || null, (adAccount?.id ?? null) === row.ad_account_id],
    );
  }
  await tx.query("update analytics_meta_connections set reload_daily = $1, updated_at = now() where id = true", [reloadDaily]);
  const saved = (await connectionRow(tx))!;
  await writeAuditEvent(tx, {
    eventType: "analytics.meta_settings_saved",
    entityType: "analytics_meta_connection",
    entityId: "meta",
    details: { pageId: saved.page_id, instagramId: saved.instagram_id, adAccountId: saved.ad_account_id, reloadDaily },
  });
  return { connection: toConnection(saved, true), startAgain };
}

/** Drops one part's tables (after choosing another Page or ad account), or every Meta table. */
export async function dropMetaTables(organisationId: string, parts?: MetaPart[]): Promise<string[]> {
  if (!parts) return dropTablesWithPrefix(organisationId, META_TABLE_PREFIX);
  const dropped: string[] = [];
  for (const part of parts) dropped.push(...(await dropTablesWithPrefix(organisationId, `meta_${part}_`)));
  return dropped;
}

// Loading (META3-META6) ------------------------------------------------------------------------

const graphUrl = (path: string, params: Record<string, string>) => `${META_GRAPH}/${path}?${new URLSearchParams(params)}`;

type PartResult = { tables: DatedTableCopy[]; through: string };

function dated(name: string, rows: Array<Array<string | null>>, from: string, through: string): DatedTableCopy {
  return { name, columns: metaTableColumns(metaTable(name)), rows, days: { dateColumn: "date", from, through } };
}

/** The Page: daily insights 90 days a question, then its posts with their insights. */
async function readFacebook(row: ConnectionRow, today: string, window: MetaWindow, postsFrom: string): Promise<PartResult> {
  const token = decryptSecret(row.page_token_ciphertext!);
  const pageId = row.page_id!;
  const data: MetaInsight[] = [];
  for (const chunk of metaChunks(window.from, window.to, META_PAGE_CHUNK_DAYS)) {
    const answer = await graph<{ data?: MetaInsight[] }>(
      graphUrl(`${pageId}/insights`, {
        metric: META_PAGE_METRICS.join(","),
        period: "day",
        since: String(metaMidnight(chunk.from)),
        until: String(metaMidnight(metaAddDays(chunk.to, 1))),
        access_token: token,
      }),
      "the Page's insights",
    );
    data.push(...(answer.data ?? []));
  }
  const changingFrom = metaAddDays(today, -META_SETTLE_DAYS);
  const daily = metaPageDailyRows(data, row.page_name ?? pageId, window.from, window.to, changingFrom);
  const since = String(metaMidnight(postsFrom));
  const posts = await metaReadAllPages<MetaPagePost>(
    (after) =>
      graph(
        graphUrl(`${pageId}/published_posts`, {
          fields: `id,created_time,message,permalink_url,status_type,insights.metric(${META_POST_METRICS.join(",")})`,
          since,
          limit: "50",
          access_token: token,
          ...(after ? { after } : {}),
        }),
        "the Page's posts",
      ),
    (post) => typeof post.created_time === "string" && metaPostedDay(post.created_time).day < postsFrom,
    META_MAX_POSTS,
  );
  const postRows = posts.map((post) => metaPagePostRow(post, metaAddDays(today, -(META_POST_REFRESH_DAYS - 1))));
  return { tables: [dated("meta_facebook_daily", daily, window.from, window.to), dated("meta_facebook_posts", postRows, postsFrom, today)], through: window.to };
}

/** Instagram: each day's account totals (two questions a day), today's follower count, then its posts with each one's insights. */
async function readInstagram(row: ConnectionRow, today: string, window: MetaWindow, postsFrom: string): Promise<PartResult> {
  const token = decryptSecret(row.page_token_ciphertext!);
  const igId = row.instagram_id!;
  const account = row.instagram_username ? `@${row.instagram_username}` : igId;
  const changingFrom = metaAddDays(today, -META_SETTLE_DAYS);
  const daily: Array<Array<string | null>> = [];
  for (const day of metaDays(window.from, window.to)) {
    const since = String(metaMidnight(day));
    const until = String(metaMidnight(metaAddDays(day, 1)));
    const totals = await graph<{ data?: MetaInsight[] }>(
      graphUrl(`${igId}/insights`, { metric: META_INSTAGRAM_METRICS.join(","), period: "day", metric_type: "total_value", since, until, access_token: token }),
      "the Instagram account's insights",
    );
    const follows = await graph<{ data?: MetaInsight[] }>(
      graphUrl(`${igId}/insights`, { metric: META_INSTAGRAM_FOLLOWS, period: "day", metric_type: "total_value", breakdown: "follow_type", since, until, access_token: token }),
      "the Instagram account's follows",
    );
    daily.push(metaInstagramDayRow(day, account, totals.data, follows.data, changingFrom));
  }
  const profile = await graph<{ followers_count?: number; username?: string }>(graphUrl(igId, { fields: "followers_count,username", access_token: token }), "the Instagram account");
  const followers = [[today, account, typeof profile.followers_count === "number" ? String(Math.trunc(profile.followers_count)) : null]];
  const media = await metaReadAllPages<MetaMedia>(
    (after) =>
      graph(
        graphUrl(`${igId}/media`, { fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count", limit: "50", access_token: token, ...(after ? { after } : {}) }),
        "the Instagram account's posts",
      ),
    (item) => typeof item.timestamp === "string" && metaPostedDay(item.timestamp).day < postsFrom,
    META_MAX_POSTS,
  );
  const postChanging = metaAddDays(today, -(META_POST_REFRESH_DAYS - 1));
  const posts: Array<Array<string | null>> = [];
  for (const item of media) {
    if (item.media_product_type === "STORY") continue;
    let insights: MetaInsight[] | null = null;
    try {
      insights = (await graph<{ data?: MetaInsight[] }>(graphUrl(`${item.id}/insights`, { metric: metaMediaMetrics(item).join(","), access_token: token }), "an Instagram post's insights")).data ?? [];
    } catch (error) {
      // A post from before the account was a professional one has no insights: keep it, with its likes and comments.
      if (!(error instanceof MetaApiError && error.kind === "no_insights")) throw error;
    }
    posts.push(metaInstagramPostRow(item, insights, postChanging));
  }
  return {
    tables: [dated("meta_instagram_daily", daily, window.from, window.to), dated("meta_instagram_followers", followers, today, today), dated("meta_instagram_posts", posts, postsFrom, today)],
    through: window.to,
  };
}

/** Ads: by campaign and day, a month a question, paged. Days are the ad account's own. */
async function readAds(row: ConnectionRow, today: string, window: MetaWindow): Promise<PartResult> {
  const token = decryptSecret(row.user_token_ciphertext);
  const rows: Array<Array<string | null>> = [];
  const changingFrom = metaAddDays(today, -META_ADS_SETTLE_DAYS);
  for (const chunk of metaChunks(window.from, window.to, META_ADS_CHUNK_DAYS)) {
    const entries = await metaReadAllPages<MetaAdsRow>((after) =>
      graph(
        graphUrl(`${row.ad_account_id}/insights`, {
          level: "campaign",
          time_increment: "1",
          time_range: JSON.stringify({ since: chunk.from, until: chunk.to }),
          fields: META_ADS_FIELDS.join(","),
          limit: "500",
          access_token: token,
          ...(after ? { after } : {}),
        }),
        "the ad account",
      ),
    );
    for (const entry of entries) rows.push(metaAdsRow(entry, changingFrom));
  }
  return { tables: [dated("meta_ads_daily", rows, window.from, window.to)], through: window.to };
}

const PART_NAME: Record<MetaPart, string> = { facebook: "Facebook Page", instagram: "Instagram", ads: "Ads" };

/**
 * Loads what's chosen now (nightly, or Refresh now). The record of the load
 * is written before and after; Meta is read with no transaction open. Each
 * part (Page, Instagram, ads) goes back as far as Meta keeps the first time,
 * then only the new days and the ones that may still change. The parts that
 * read fully are written together in one transaction; a part that failed
 * changes nothing and carries on next time (META3-META6).
 */
export async function refreshMeta(organisation: OrganisationRecord, actor: Actor, trigger: "schedule" | "manual", now = new Date()): Promise<LoadRun> {
  const started = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx);
    if (!row) throw new NotFoundError("Meta isn't connected.");
    if (!row.page_id) throw new ConflictError("Choose the Facebook Page to load first.");
    const busy = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [
      META_LOAD_TABLE_NAME,
    ]);
    if (busy.rows.length > 0) throw new ConflictError("Meta is loading already.");
    const what = [row.page_name ?? "Page", row.instagram_username ? `@${row.instagram_username}` : null, row.ad_account_name ? `ads: ${row.ad_account_name}` : null].filter(Boolean).join(", ");
    const run = await tx.query<{ id: string }>(
      `insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger, requested_by_email)
       values (null, $1, $2, $3, $4, $5) returning id::text`,
      [META_SOURCE_NAME, META_LOAD_TABLE_NAME, what.slice(0, 500), trigger, trigger === "manual" ? actor.email : null],
    );
    return { runId: run.rows[0].id };
  });

  const began = performance.now();
  let rows: number | null = null;
  const errors: string[] = [];
  const done: Partial<Record<MetaPart, string>> = {};
  let loaded: ConnectionRow | null = null;
  try {
    const { row } = await loadConnection(organisation, actor);
    loaded = row;
    if (row.needs_reconnect) throw new ConflictError(reconnectText(row.reconnect_reason));
    const present = new Set(await tablesWithPrefix(organisation.id, META_TABLE_PREFIX));
    const has = (part: MetaPart) => META_TABLES.filter((table) => table.part === part).every((table) => present.has(table.table));
    const today = metaToday(now);
    const tables: DatedTableCopy[] = [];
    const parts: Array<{ part: MetaPart; read: () => Promise<PartResult> }> = [];
    {
      const window = metaWindow(today, metaAddDays(today, -META_PAGE_HISTORY_DAYS), row.facebook_loaded_through, has("facebook"), META_SETTLE_DAYS);
      // Posts the last load marked as still changing are read again, and any since.
      const postsFrom = window.first ? window.from : metaAddDays(row.facebook_loaded_through!, -(META_POST_REFRESH_DAYS - 1));
      parts.push({ part: "facebook", read: () => readFacebook(row, today, window, postsFrom) });
    }
    if (row.instagram_id) {
      const window = metaWindow(today, metaAddDays(today, -META_INSTAGRAM_HISTORY_DAYS), row.instagram_loaded_through, has("instagram"), META_SETTLE_DAYS);
      const postsFrom = window.first ? metaAddDays(today, -META_PAGE_HISTORY_DAYS) : metaAddDays(row.instagram_loaded_through!, -(META_POST_REFRESH_DAYS - 1));
      parts.push({ part: "instagram", read: () => readInstagram(row, today, window, postsFrom) });
    }
    if (row.ad_account_id) {
      const adsToday = isoDateAt(now, row.ad_time_zone || "UTC");
      const window = metaWindow(adsToday, metaMonthsBefore(adsToday, META_ADS_HISTORY_MONTHS), row.ads_loaded_through, has("ads"), META_ADS_SETTLE_DAYS);
      parts.push({ part: "ads", read: () => readAds(row, adsToday, window) });
    }
    for (const { part, read } of parts) {
      try {
        const result = await read();
        tables.push(...result.tables);
        done[part] = result.through;
      } catch (error) {
        if (error instanceof MetaApiError && error.kind === "signin") await markReconnect(organisation, actor, error);
        errors.push(`${PART_NAME[part]}: ${error instanceof Error ? error.message : String(error)}`);
        // Once Meta's limit is reached, more calls only make the wait longer (Meta's rate limits page).
        if (error instanceof MetaApiError && error.kind === "limit") break;
      }
    }
    if (tables.length) rows = await mergeTableWindows(organisation.id, META_TABLE_PREFIX, tables, "The Meta data couldn't be loaded");
  } catch (caught) {
    errors.push(caught instanceof Error ? caught.message : String(caught));
    for (const part of Object.keys(done) as MetaPart[]) delete done[part];
  }
  const milliseconds = Math.round(performance.now() - began);
  const kept = Object.keys(done) as MetaPart[];
  let error = errors.length ? errors.join(" ") : null;
  if (error && kept.length) error += ` ${kept.map((part) => `${PART_NAME[part]} loaded to ${formatDate(done[part]!)}`).join("; ")}.`;

  const run = await withOrganisationTransaction(organisation, actor, async (tx) => {
    if (loaded) {
      // Only if the same Page and ad account are still chosen.
      await tx.query(
        `update analytics_meta_connections set facebook_loaded_through = coalesce($1::date, facebook_loaded_through),
                instagram_loaded_through = case when instagram_id is not distinct from $5 then coalesce($2::date, instagram_loaded_through) else instagram_loaded_through end,
                ads_loaded_through = case when ad_account_id is not distinct from $6 then coalesce($3::date, ads_loaded_through) else ads_loaded_through end,
                updated_at = now() where id = true and page_id = $4`,
        [done.facebook ?? null, done.instagram ?? null, done.ads ?? null, loaded.page_id, loaded.instagram_id, loaded.ad_account_id],
      );
    }
    const result = await tx.query<RunRow>(
      `update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5 where id = $1 returning ${RUN_COLUMNS}`,
      [started.runId, error ? "failed" : "ok", rows === null ? null : String(rows), milliseconds, error],
    );
    return toRun(result.rows[0]);
  });
  if (kept.length) {
    try {
      await rebuildShapedTablesForTables(organisation, actor, META_TABLES.filter((table) => kept.includes(table.part)).map((table) => table.table), trigger);
    } catch (caught) {
      console.warn("[tohyee] Shaped tables after loading Meta:", caught instanceof Error ? caught.message : caught);
    }
  }
  return run;
}

/** Whether the nightly load should consider Meta: a Page chosen, nightly on, and the sign-in still good. */
export async function metaLoadsNightly(tx: OrgTx): Promise<boolean> {
  const row = await connectionRow(tx);
  return Boolean(row && row.page_id && row.reload_daily && !row.needs_reconnect);
}

// Check setup (META8) ------------------------------------------------------------------------

export type MetaCheck = { id: string; label: string; state: "ok" | "problem" | "warning" | "skipped"; text: string };

/**
 * Goes through the setup and says plainly what's wrong and how to fix it:
 * the server key, the app, the sign-in and its permissions, the Page and
 * its Instagram account, and the ad account. Read-only; it asks Meta, never
 * changes anything. Admins and owners.
 */
export async function checkMetaSetup(organisation: OrganisationRecord, actor: Actor, now = new Date()): Promise<MetaCheck[]> {
  const checks: MetaCheck[] = [];
  const facts = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    return { app: await appRow(tx), row: await connectionRow(tx) };
  });
  checks.push(
    secretsAvailable()
      ? { id: "server", label: "Server key", state: "ok", text: "The server can store Meta's sign-in safely." }
      : { id: "server", label: "Server key", state: "problem", text: "The server has no TOHYEE_SECRET_KEY, so it can't store Meta's sign-in. Whoever runs the server needs to set it." },
  );
  if (!facts.app) {
    checks.push({ id: "app", label: "Meta app", state: "problem", text: "No Meta app is saved yet. Follow steps 1 to 4 above, then save the App ID and App secret." });
    return checks;
  }
  let app: MetaApp | null = null;
  try {
    app = { appId: facts.app.app_id, secret: decryptSecret(facts.app.app_secret_ciphertext), configId: facts.app.config_id };
    const found = await graph<{ id?: string; name?: string }>(graphUrl(app.appId, { fields: "id,name", access_token: `${app.appId}|${app.secret}` }), "the app");
    checks.push({ id: "app", label: "Meta app", state: "ok", text: `Meta knows the app${found.name ? ` "${found.name.slice(0, 100)}"` : ""} and accepts its secret.` });
  } catch (error) {
    checks.push({
      id: "app",
      label: "Meta app",
      state: "problem",
      text: `Meta didn't accept the App ID and App secret together. Copy both again from App settings › Basic in Meta for Developers (choose Show beside App secret), and save.${error instanceof MetaApiError && error.failure.message ? ` Meta said: ${error.failure.message.slice(0, 200)}` : ""}`,
    });
    return checks;
  }
  const row = facts.row;
  if (!row) {
    checks.push({ id: "signin", label: "Sign-in", state: "skipped", text: "Not connected yet. Choose Connect Meta on the Data sources screen." });
    return checks;
  }
  if (row.needs_reconnect) {
    checks.push({ id: "signin", label: "Sign-in", state: "problem", text: reconnectText(row.reconnect_reason) });
    return checks;
  }
  let debug: Awaited<ReturnType<typeof debugToken>>;
  try {
    debug = await debugToken(app, decryptSecret(row.user_token_ciphertext));
  } catch (error) {
    checks.push({ id: "signin", label: "Sign-in", state: "problem", text: error instanceof Error ? error.message : String(error) });
    return checks;
  }
  if (!debug.valid) {
    checks.push({ id: "signin", label: "Sign-in", state: "problem", text: "Meta says the sign-in is no longer valid (it ran out, the password changed, or the app was removed). Connect again." });
  } else {
    const ends = [debug.expiresAt, debug.dataAccessExpiresAt].filter((value): value is string => Boolean(value)).sort()[0];
    const soon = ends && Date.parse(ends) - now.getTime() < WARN_DAYS * 86_400_000;
    checks.push({
      id: "signin",
      label: "Sign-in",
      state: soon ? "warning" : "ok",
      text: ends
        ? `Signed in as ${row.facebook_user_name ?? "a Facebook account"}. Meta ends this sign-in on ${formatDate(ends.slice(0, 10))}${soon ? ": connect again before then to keep ads and Page lists working" : ""}. The Page's own access carries on after that.`
        : `Signed in as ${row.facebook_user_name ?? "a Facebook account"}.`,
    });
  }
  const granted = debug.scopes.length ? debug.scopes : list(row.granted_permissions);
  const missing = [...missingPagePermissions(granted), ...META_INSTAGRAM_PERMISSIONS.filter((name) => !granted.includes(name))];
  checks.push(
    missing.length
      ? {
          id: "permissions",
          label: "Permissions",
          state: "problem",
          text: `Not allowed: ${missing.map((name) => `${name} (${META_PERMISSION_TEXT[name]})`).join(", ")}. Connect again and leave them ticked. If Meta doesn't ask for them, add them to the app (Use cases, or the Facebook Login for Business configuration) and make sure you have a role on the app.`,
        }
      : { id: "permissions", label: "Permissions", state: "ok", text: "Everything Tohyee needs to read the Page and Instagram is allowed. Nothing allows posting or changing anything." },
  );
  let accounts: Awaited<ReturnType<typeof readAccounts>> | null = null;
  try {
    accounts = await readAccounts(row);
  } catch (error) {
    checks.push({ id: "page", label: "Facebook Page", state: "problem", text: error instanceof Error ? error.message : String(error) });
  }
  if (accounts) {
    const page = row.page_id ? accounts.pages.find((entry) => entry.id === row.page_id) : undefined;
    if (!accounts.pages.length) {
      checks.push({
        id: "page",
        label: "Facebook Page",
        state: "problem",
        text: "Meta lists no Pages for this sign-in. Connect again and, when Meta asks which Pages Tohyee can use, tick yours. You need a role on the Page with access to insights (full control, or the Insights task in Meta Business Suite).",
      });
    } else if (!row.page_id) {
      checks.push({ id: "page", label: "Facebook Page", state: "warning", text: "No Page chosen yet. Choose it on the Data sources screen." });
    } else if (!page) {
      checks.push({ id: "page", label: "Facebook Page", state: "problem", text: `This sign-in can no longer see ${row.page_name ?? "the chosen Page"}. Connect again and tick it when Meta asks which Pages to share.` });
    } else if (!page.canAnalyse) {
      checks.push({ id: "page", label: "Facebook Page", state: "problem", text: `Your role on ${page.name} can't see insights. Ask the Page's admin for full control or the Insights task (Meta Business Suite › Settings › People).` });
    } else {
      checks.push({ id: "page", label: "Facebook Page", state: "ok", text: `${page.name} is chosen and its insights can be read.` });
    }
    const chosen = page ?? (accounts.pages.length === 1 ? accounts.pages[0] : undefined);
    if (chosen) {
      checks.push(
        chosen.instagram
          ? {
              id: "instagram",
              label: "Instagram",
              state: "ok",
              text: `@${chosen.instagram.username} is a professional (business or creator) account linked to ${chosen.name}.${chosen.instagram.followers !== null && chosen.instagram.followers < 100 ? " It has fewer than 100 followers, so Meta leaves out follows and unfollows." : ""}`,
            }
          : {
              id: "instagram",
              label: "Instagram",
              state: "warning",
              text: `No Instagram account is linked to ${chosen.name}, so only the Page loads. To add it: in the Instagram app, go to your profile › Menu › Account type and tools › Switch to professional account (Business or Creator). Then link it to the Page: in Meta Business Suite, Settings › Instagram accounts › Connect account (or on the Page, Settings › Linked accounts). Then choose Connect again here.`,
            },
      );
    }
    if (!accounts.canReadAds) {
      checks.push({ id: "ads", label: "Ads", state: "skipped", text: "Ads aren't being read. To add them, choose Connect again with Also load ads ticked (needs the app's Marketing API use case)." });
    } else if (row.ad_account_id) {
      const ad = accounts.adAccounts.find((entry) => entry.id === row.ad_account_id);
      checks.push(
        !ad
          ? { id: "ads", label: "Ads", state: "problem", text: `This sign-in can no longer see the ad account ${row.ad_account_name ?? row.ad_account_id}. Ask its admin to add you in Meta Business Suite › Settings › Ad accounts.` }
          : ad.active
            ? { id: "ads", label: "Ads", state: "ok", text: `${ad.name} (${ad.currency}) can be read.` }
            : { id: "ads", label: "Ads", state: "warning", text: `${ad.name} isn't active in Meta (closed, disabled or with a payment problem). Its past results still load.` },
      );
    } else {
      checks.push({ id: "ads", label: "Ads", state: "skipped", text: accounts.adAccounts.length ? "Ads can be read; no ad account is chosen." : "Ads can be read, but this sign-in can't see any ad accounts." });
    }
  }
  return checks;
}

// Disconnecting (META9) ------------------------------------------------------------------------

/**
 * Disconnects: deletes the tokens and the connection, then (after it
 * commits) asks Meta to remove the app's permissions and drops every
 * `meta_*` table. The saved app and the load history stay. Refused while a
 * shaped table is built from the data, or a load is running.
 */
export async function disconnectMeta(organisation: OrganisationRecord, actor: Actor): Promise<void> {
  const userToken = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const row = await connectionRow(tx, true);
    if (!row) throw new NotFoundError("Meta isn't connected.");
    const running = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [
      META_LOAD_TABLE_NAME,
    ]);
    if (running.rows.length > 0) throw new ConflictError("Meta is loading. Try again when it's finished.");
    const users = new Set<string>();
    for (const table of META_TABLES) for (const name of await shapesUsing(tx, table.table)) users.add(name);
    if (users.size > 0) {
      const names = [...users];
      throw new ConflictError(`The shaped table${names.length === 1 ? "" : "s"} ${names.join(", ")} ${names.length === 1 ? "uses" : "use"} Meta data. Change or remove ${names.length === 1 ? "it" : "them"} first.`);
    }
    await tx.query("delete from analytics_meta_connections where id = true");
    await tx.query("delete from analytics_meta_states");
    await writeAuditEvent(tx, { eventType: "analytics.meta_disconnected", entityType: "analytics_meta_connection", entityId: "meta", details: { pageId: row.page_id, instagramId: row.instagram_id, adAccountId: row.ad_account_id } });
    return decryptSecret(row.user_token_ciphertext);
  });
  // A courtesy: the tokens are already deleted here, so a failure doesn't matter.
  try {
    await providerFetch(`${META_GRAPH}/me/permissions?${new URLSearchParams({ access_token: userToken })}`, { method: "DELETE", signal: AbortSignal.timeout(15_000) });
  } catch {
    // Nothing more to do.
  }
  await dropMetaTables(organisation.id);
}
