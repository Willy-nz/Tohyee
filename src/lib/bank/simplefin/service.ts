import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import { randomInt } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { addStatementLines, lockStatementAccount } from "@/lib/bank/accounts";
import { FEED_ACTOR } from "@/lib/bank/akahu/sync";
import { makeLine, type ParsedStatementLine } from "@/lib/bank/formats/common";
import {
  accessHost,
  claimSetupToken,
  fetchAccounts,
  MAX_DAYS_PER_REQUEST,
  type SimpleFinAccount,
  type SimpleFinAccountSet,
  type SimpleFinProblem,
  type SimpleFinTransaction,
  simpleFinProblem,
} from "@/lib/bank/simplefin/client";
import { businessTimeZone, parseIsoDate } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { newLoginName, pickLogin } from "@/lib/bank/logins";
import { requireId, requireString } from "@/lib/validation";

/**
 * SimpleFIN bank feeds (SF1-SF10, decisions 388-391): the organisation's own
 * SimpleFIN Bridge connection, its linked accounts, and syncs. The network
 * calls happen between short database transactions, never inside one.
 */
export const DEFAULT_SIMPLEFIN_HOURS = 6;
/** Sync now stops at this many requests in 24 hours, leaving room for the schedule (Jess, 5 Oct 2026). */
export const MANUAL_REQUEST_LIMIT = 20;
/** The Bridge's own limit (its developer guide). The schedule never goes past it. */
export const BRIDGE_REQUEST_LIMIT = 24;
/** Later syncs go back this far before the last line, to catch late postings (they're skipped if already here). */
const OVERLAP_DAYS = 10;
const MAX_SKIPPED = 50;
const DAY = 86_400;

export type SimpleFinAccountOption = {
  id: string;
  name: string;
  currency: string;
  connectionName: string | null;
  balance: string | null;
  linkedAccountId: string | null;
};

export type SimpleFinConnectionStatus = {
  connected: boolean;
  /** The login (#182, BK30): its id and name; null when nothing is connected. */
  connectionId: string | null;
  name: string | null;
  host: string | null;
  syncEveryHours: number;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncError: string | null;
  problems: string[];
  requestsLast24h: number;
  accounts: SimpleFinAccountOption[];
  createdAt: string | null;
  createdByEmail: string | null;
  secretsAvailable: boolean;
};

/** The first login's status (as before several logins), and every login's. */
export type SimpleFinStatus = SimpleFinConnectionStatus & { connections: SimpleFinConnectionStatus[] };

export type SimpleFinLink = {
  /** The login it syncs with (#182). */
  connectionId: string | null;
  loginName: string | null;
  simplefinAccountId: string;
  simplefinAccountName: string | null;
  connectionName: string | null;
  currencyCode: string;
  startDate: string;
  timeZone: string;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncError: string | null;
  skipped: Array<{ id: string | null; reason: string }>;
  /** The earliest line SimpleFIN has given this account (SF5). */
  firstLineDate: string | null;
};

type StoredAccount = {
  id: string;
  name: string;
  currency: string;
  connectionName: string | null;
  connectionId: string | null;
  balance: string | null;
};

type ConnectionRow = {
  id: string;
  name: string;
  access_url_ciphertext: string;
  host: string;
  sync_every_hours: number;
  sync_minute: number;
  last_synced_at: string | null;
  last_sync_status: "never" | "ok" | "failed";
  last_sync_error: string | null;
  last_problems: string[];
  accounts: StoredAccount[];
  lease_until: string | null;
  created_at: string;
  created_by_email: string | null;
};

function requireSecrets(): void {
  if (!secretsAvailable()) {
    throw new UnavailableError(
      "This server has no TOHYEE_SECRET_KEY, so the SimpleFIN connection can't be stored safely. The server admin needs to set it (32+ random characters) and restart Tohyee.",
    );
  }
}

async function activeConnections(tx: OrgTx, lock = false): Promise<ConnectionRow[]> {
  const result = await tx.query<ConnectionRow>(
    `select id::text, name, access_url_ciphertext, host, sync_every_hours, sync_minute, last_synced_at, last_sync_status, last_sync_error,
            last_problems, accounts, lease_until, created_at, created_by_email
       from simplefin_connections where status = 'active' order by simplefin_connections.id ${lock ? "for update" : ""}`,
  );
  return result.rows;
}

/** The login a command is for (#182): the one chosen by `connectionId`, or the only one. */
async function activeConnection(tx: OrgTx, lock = false, connectionId?: unknown): Promise<ConnectionRow | null> {
  return pickLogin(await activeConnections(tx, lock), connectionId, "simplefin");
}

async function requestsSince(tx: OrgTx, hours = 24): Promise<{ count: number; oldest: string | null }> {
  const result = await tx.query<{ count: number; oldest: string | null }>(
    "select count(*)::int as count, min(made_at) as oldest from simplefin_requests where made_at > now() - make_interval(hours => $1)",
    [hours],
  );
  return { count: result.rows[0].count, oldest: result.rows[0].oldest ? new Date(result.rows[0].oldest).toISOString() : null };
}

function parseHours(input: unknown, fallback: number): number {
  if (input == null || input === "") return fallback;
  const hours = Number(input);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new ValidationError("Sync every must be 1 to 24 hours.");
  return hours;
}

/** A time zone name the server knows (e.g. America/Los_Angeles). */
export function parseTimeZone(input: unknown): string {
  if (input == null || input === "") return businessTimeZone();
  if (typeof input !== "string" || input.length > 64) throw new ValidationError("Choose a time zone.");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: input });
  } catch {
    throw new ValidationError(`${input} isn't a time zone Tohyee knows.`);
  }
  return input;
}

function dateIn(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(seconds * 1000));
}

function storedAccounts(set: SimpleFinAccountSet): StoredAccount[] {
  return set.accounts.map((account) => ({
    id: account.id,
    name: (typeof account.name === "string" && account.name.trim()) || account.id,
    currency: account.currency,
    connectionId: account.conn_id ?? null,
    connectionName: (account.conn_id && set.connections[account.conn_id]) || account.org?.name || null,
    balance: typeof account.balance === "string" ? account.balance : null,
  }));
}

function problemText(problem: SimpleFinProblem): string {
  return `SimpleFIN: ${problem.message.replace(/[.\s]+$/, "")} (fix it in SimpleFIN Bridge).`.slice(0, 500);
}

export async function getSimpleFinStatus(tx: OrgTx): Promise<SimpleFinStatus> {
  const rows = await activeConnections(tx);
  const links = await tx.query<{ account_id: string; simplefin_account_id: string }>(
    "select account_id::text, simplefin_account_id from simplefin_links where active",
  );
  const linked = new Map(links.rows.map((link) => [link.simplefin_account_id, link.account_id]));
  // The Bridge's daily limit is counted for the organisation as a whole (decision 391), across its logins.
  const requests = rows.length ? (await requestsSince(tx)).count : 0;
  const connections = rows.map((row) => connectionStatus(row, linked, requests));
  return { ...(connections[0] ?? connectionStatus(null, linked, 0)), connections };
}

function connectionStatus(row: ConnectionRow | null, linked: ReadonlyMap<string, string>, requests: number): SimpleFinConnectionStatus {
  return {
    connected: row !== null,
    connectionId: row?.id ?? null,
    name: row?.name ?? null,
    host: row?.host ?? null,
    syncEveryHours: row?.sync_every_hours ?? DEFAULT_SIMPLEFIN_HOURS,
    lastSyncedAt: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastSyncStatus: row?.last_sync_status ?? "never",
    lastSyncError: row?.last_sync_error ?? null,
    problems: row?.last_problems ?? [],
    requestsLast24h: requests,
    accounts: (row?.accounts ?? []).map((account) => ({
      id: account.id,
      name: account.name,
      currency: account.currency,
      connectionName: account.connectionName,
      balance: account.balance,
      linkedAccountId: linked.get(account.id) ?? null,
    })),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    createdByEmail: row?.created_by_email ?? null,
    secretsAvailable: secretsAvailable(),
  };
}

/**
 * Connects the organisation's SimpleFIN Bridge (SF1): claims the setup token
 * (it works once), stores the access URL encrypted, and lists the accounts.
 * Admins. One connection at a time: disconnect first to change it.
 */
export async function connectSimpleFin(
  organisation: OrganisationRecord,
  actor: Actor,
  input: { name?: unknown; setupToken?: unknown; syncEveryHours?: unknown },
): Promise<SimpleFinStatus> {
  requireSecrets();
  const hours = parseHours(input.syncEveryHours, DEFAULT_SIMPLEFIN_HOURS);
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    // Several logins (#182): only the name must be new.
    await newLoginName(tx, "simplefin", input.name);
  });
  let access: string;
  let set: SimpleFinAccountSet;
  try {
    access = await claimSetupToken(input.setupToken);
    set = await fetchAccounts(access, { balancesOnly: true });
  } catch (error) {
    throw simpleFinProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query("lock table simplefin_connections in share row exclusive mode");
    const name = await newLoginName(tx, "simplefin", input.name);
    const inserted = await tx.query<{ id: string }>(
      `insert into simplefin_connections (access_url_ciphertext, host, sync_every_hours, sync_minute, accounts, last_problems, created_by_email, name)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) returning id::text`,
      [
        encryptSecret(access),
        accessHost(access),
        hours,
        randomInt(60),
        JSON.stringify(storedAccounts(set)),
        JSON.stringify(set.problems.map(problemText)),
        tx.actor.email,
        name,
      ],
    );
    const id = inserted.rows[0].id;
    await tx.query("insert into simplefin_requests (connection_id) values ($1)", [id]);
    await writeAuditEvent(tx, {
      eventType: "bank_feed.simplefin_connected",
      entityType: "simplefin_connection",
      entityId: id,
      details: { host: accessHost(access), accounts: set.accounts.length, syncEveryHours: hours },
    });
    return getSimpleFinStatus(tx);
  });
}

/** Changes how often SimpleFIN is synced (1-24 hours). Admins. */
export async function updateSimpleFinSettings(tx: OrgTx, input: { syncEveryHours?: unknown; connectionId?: unknown }): Promise<SimpleFinStatus> {
  const row = await activeConnection(tx, true, input.connectionId);
  if (!row) throw new NotFoundError("SimpleFIN isn't connected.");
  const hours = parseHours(input.syncEveryHours, row.sync_every_hours);
  await tx.query("update simplefin_connections set sync_every_hours = $2 where id = $1", [row.id, hours]);
  await writeAuditEvent(tx, {
    eventType: "bank_feed.simplefin_updated",
    entityType: "simplefin_connection",
    entityId: row.id,
    details: { syncEveryHours: hours },
  });
  return getSimpleFinStatus(tx);
}

/**
 * Disconnects (SF10): the stored access URL is deleted and every account
 * unlinked. Lines and reconciliations stay. Admins.
 */
export async function disconnectSimpleFin(tx: OrgTx, connectionId?: unknown): Promise<SimpleFinStatus> {
  const row = await activeConnection(tx, true, connectionId);
  if (!row) throw new NotFoundError("SimpleFIN isn't connected.");
  if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("SimpleFIN is syncing. Try again in a minute.");
  const unlinked = await tx.query(
    // Only this login's accounts (#182, BK35).
    "update simplefin_links set active = false, connection_id = null, updated_at = now() where active and connection_id = $1",
    [row.id],
  );
  await tx.query(
    `update simplefin_connections set status = 'removed', access_url_ciphertext = null, removed_at = now(), removed_by_email = $2 where id = $1`,
    [row.id, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.simplefin_disconnected",
    entityType: "simplefin_connection",
    entityId: row.id,
    details: { unlinkedAccounts: unlinked.rowCount ?? 0 },
  });
  return getSimpleFinStatus(tx);
}

async function linkRow(tx: OrgTx, accountId: string) {
  const result = await tx.query<{
    simplefin_account_id: string;
    simplefin_account_name: string | null;
    connection_name: string | null;
    currency_code: string;
    start_date: string;
    time_zone: string;
    active: boolean;
    last_synced_at: string | null;
    last_sync_status: "never" | "ok" | "failed";
    last_sync_error: string | null;
    last_skipped: Array<{ id: string | null; reason: string }>;
    connection_id: string | null;
    login_name: string | null;
  }>(
    `select l.simplefin_account_id, l.simplefin_account_name, l.connection_name, l.currency_code, l.start_date::text, l.time_zone, l.active,
            l.last_synced_at, l.last_sync_status, l.last_sync_error, l.last_skipped, l.connection_id::text, c.name as login_name
       from simplefin_links l left join simplefin_connections c on c.id = l.connection_id where l.account_id = $1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

/** The account's SimpleFIN link, or null (viewers). */
export async function getSimpleFinLink(tx: OrgTx, accountIdInput: unknown): Promise<SimpleFinLink | null> {
  const accountId = requireId(accountIdInput, "accountId");
  const row = await linkRow(tx, accountId);
  if (!row?.active) return null;
  const first = await tx.query<{ first: string | null }>(
    `select min(b.line_date)::text as first from bank_statement_lines b join bank_statement_imports i on i.id = b.import_id
      where b.account_id = $1 and i.source = 'simplefin' and b.status <> 'deleted'`,
    [accountId],
  );
  return {
    connectionId: row.connection_id,
    loginName: row.login_name,
    simplefinAccountId: row.simplefin_account_id,
    simplefinAccountName: row.simplefin_account_name,
    connectionName: row.connection_name,
    currencyCode: row.currency_code,
    startDate: row.start_date,
    timeZone: row.time_zone,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
    skipped: row.last_skipped ?? [],
    firstLineDate: first.rows[0]?.first ?? null,
  };
}

/**
 * Links a SimpleFIN account to a bank or credit card account (SF2): its
 * currency must be the account's, it can be linked once, and an account with
 * an Akahu feed can't have a second feed. Admins.
 */
export async function linkSimpleFinAccount(
  tx: OrgTx,
  accountIdInput: unknown,
  input: { simplefinAccountId?: unknown; startDate?: unknown; timeZone?: unknown; connectionId?: unknown },
): Promise<SimpleFinLink> {
  const accountId = requireId(accountIdInput, "accountId");
  const simplefinAccountId = requireString(input.simplefinAccountId, "SimpleFIN account", { maxLength: 200 });
  const startDate = parseIsoDate(input.startDate, "startDate");
  const timeZone = parseTimeZone(input.timeZone);
  // The login it's listed under (#182): the one chosen, the only one, or the one whose list has it.
  const logins = await activeConnections(tx);
  const connection =
    input.connectionId != null && input.connectionId !== ""
      ? await activeConnection(tx, false, input.connectionId)
      : logins.length > 1
        ? (logins.find((login) => login.accounts.some((account) => account.id === simplefinAccountId)) ?? null)
        : (logins[0] ?? null);
  if (!connection) throw new ValidationError(logins.length ? "SimpleFIN didn't list that account. Refresh the account list and try again." : "Connect SimpleFIN first (Bank accounts → SimpleFIN bank feeds).");
  const option = connection.accounts.find((account) => account.id === simplefinAccountId);
  if (!option) throw new ValidationError("SimpleFIN didn't list that account. Refresh the account list and try again.");
  const account = await lockStatementAccount(tx, accountId, "simplefin");
  if (option.currency !== account.currencyCode) {
    throw new ValidationError(`SimpleFIN says this account is in ${option.currency}; ${account.code} is in ${account.currencyCode}.`);
  }
  const akahu = await tx.query("select 1 from bank_account_settings where account_id = $1 and feed_active", [accountId]);
  if (akahu.rowCount) throw new ConflictError(`${account.code} already has an Akahu bank feed. Stop it first.`);
  const other = await tx.query<{ feed: string }>(
    "select 'Stripe' as feed from stripe_links where account_id = $1 and active union all select 'PayPal' from paypal_links where account_id = $1 and active union all select 'Wise' from wise_links where account_id = $1 and active",
    [accountId],
  );
  if (other.rows[0]) throw new ConflictError(`${account.code} is linked to ${other.rows[0].feed}. Unlink it first.`);
  const taken = await tx.query("select 1 from simplefin_links where active and simplefin_account_id = $1 and account_id <> $2", [
    simplefinAccountId,
    accountId,
  ]);
  if (taken.rowCount) throw new ConflictError("That SimpleFIN account is already linked to another bank account.");
  await tx.query(
    `insert into simplefin_links (account_id, connection_id, simplefin_account_id, simplefin_account_name, connection_name, currency_code,
                                  start_date, time_zone, active, last_synced_at, last_sync_status, last_sync_error, last_skipped, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, true, null, 'never', null, '[]'::jsonb, $9)
     on conflict (account_id) do update set
       connection_id = excluded.connection_id, simplefin_account_id = excluded.simplefin_account_id,
       simplefin_account_name = excluded.simplefin_account_name, connection_name = excluded.connection_name,
       currency_code = excluded.currency_code, start_date = excluded.start_date, time_zone = excluded.time_zone, active = true,
       last_synced_at = null, last_sync_status = 'never', last_sync_error = null, last_skipped = '[]'::jsonb,
       created_by_email = excluded.created_by_email, updated_at = now()`,
    [
      accountId,
      connection.id,
      simplefinAccountId,
      option.name.slice(0, 200),
      option.connectionName?.slice(0, 200) ?? null,
      option.currency,
      startDate,
      timeZone,
      tx.actor.email,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.simplefin_linked",
    entityType: "account",
    entityId: accountId,
    details: { accountCode: account.code, simplefinAccountId, currency: option.currency, startDate, timeZone },
  });
  return (await getSimpleFinLink(tx, accountId))!;
}

/** Unlinks an account. Lines already brought in stay. Admins. */
export async function unlinkSimpleFinAccount(tx: OrgTx, accountIdInput: unknown): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query(
    "update simplefin_links set active = false, connection_id = null, updated_at = now() where account_id = $1 and active",
    [accountId],
  );
  if (!result.rowCount) throw new NotFoundError("This account isn't linked to SimpleFIN.");
  await writeAuditEvent(tx, { eventType: "bank_feed.simplefin_unlinked", entityType: "account", entityId: accountId });
}

type Skip = { id: string | null; reason: string };

/**
 * A SimpleFIN transaction as a statement line in the link's time zone (SF3),
 * or why it's skipped (SF9). Pending transactions are left out silently.
 */
export function lineFromSimpleFin(
  simplefinAccountId: string,
  transaction: SimpleFinTransaction,
  timeZone: string,
): { line: ParsedStatementLine } | { skip: Skip } | null {
  const id = typeof transaction.id === "string" && transaction.id.trim() ? transaction.id.trim() : null;
  if (transaction.pending === true) return null;
  if (!id) return { skip: { id: null, reason: "SimpleFIN gave no id." } };
  if (typeof transaction.posted !== "number" || !Number.isFinite(transaction.posted) || transaction.posted <= 0) {
    return { skip: { id, reason: "SimpleFIN gave no posted date." } };
  }
  if (typeof transaction.amount !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(transaction.amount.trim())) {
    return {
      skip: {
        id,
        reason:
          typeof transaction.amount === "string"
            ? `The amount "${transaction.amount.slice(0, 30)}" isn't money to the cent.`
            : "SimpleFIN gave no amount.",
      },
    };
  }
  const amount = transaction.amount.trim();
  if (/^-?0+(\.0+)?$/.test(amount)) return { skip: { id, reason: "The amount is 0.00." } };
  const [whole, cents = ""] = amount.replace("-", "").split(".");
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    line: makeLine({
      date: dateIn(transaction.posted, timeZone),
      amount: `${amount.startsWith("-") ? "-" : ""}${String(BigInt(whole))}.${cents.padEnd(2, "0")}`,
      description: text(transaction.description),
      payee: text(transaction.payee),
      particulars: text(transaction.memo),
      externalId: `simplefin:${simplefinAccountId}:${id}`,
    }),
  };
}

export type SimpleFinSyncResult = {
  status: "ok" | "failed";
  requests: number;
  added: number;
  duplicates: number;
  possibleDuplicates: number;
  skipped: number;
  error: string | null;
};

type ActiveLink = {
  account_id: string;
  simplefin_account_id: string;
  currency_code: string;
  start_date: string;
  time_zone: string;
  last_line: string | null;
  /** The day of the last good sync, so an account with no lines yet isn't fetched from its start date every time. */
  last_ok: string | null;
};

function epochOf(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

/**
 * Syncs every linked account in one go (SF3-SF9): one request per 90 days
 * (all accounts at once), from each account's start date the first time and
 * from 10 days before its last line after that. Sync now is refused at 20
 * requests in 24 hours; the schedule stops at the Bridge's 24.
 */
export async function syncSimpleFin(
  organisation: OrganisationRecord,
  actor: Actor,
  options: { manual?: boolean; connectionId?: unknown } = {},
): Promise<SimpleFinSyncResult> {
  const limit = options.manual ? MANUAL_REQUEST_LIMIT : BRIDGE_REQUEST_LIMIT;
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    requireSecrets();
    const row = await activeConnection(tx, true, options.connectionId);
    if (!row) throw new ValidationError("SimpleFIN isn't connected. An admin can connect it under Bank accounts → SimpleFIN bank feeds.");
    if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("SimpleFIN is already syncing.");
    const used = await requestsSince(tx);
    if (used.count >= limit) {
      const next = used.oldest ? new Date(new Date(used.oldest).getTime() + DAY * 1000) : new Date();
      throw new ConflictError(
        `Tohyee has asked SimpleFIN ${used.count} times in the last 24 hours (the Bridge allows ${BRIDGE_REQUEST_LIMIT}). Sync again after ${next.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      );
    }
    await tx.query("update simplefin_connections set lease_until = now() + interval '10 minutes' where id = $1", [row.id]);
    const links = await tx.query<ActiveLink>(
      `select l.account_id::text, l.simplefin_account_id, l.currency_code, l.start_date::text, l.time_zone,
              (select max(b.line_date)::text from bank_statement_lines b join bank_statement_imports i on i.id = b.import_id
                where b.account_id = l.account_id and i.source = 'simplefin' and b.status <> 'deleted') as last_line,
              case when l.last_sync_status = 'ok' then (l.last_synced_at at time zone 'UTC')::date::text end as last_ok
         from simplefin_links l where l.active and l.connection_id = $1 order by l.account_id`,
      [row.id],
    );
    return { connectionId: row.id, access: decryptSecret(row.access_url_ciphertext), used: used.count, links: links.rows };
  });

  let requests = 0;
  const totals = { added: 0, duplicates: 0, possibleDuplicates: 0, skipped: 0 };
  let error: string | null = null;
  const problems: SimpleFinProblem[] = [];
  const byAccount = new Map<string, SimpleFinTransaction[]>();
  const latest = new Map<string, SimpleFinAccount>();
  let accountSet: SimpleFinAccountSet | null = null;
  try {
    // From the earliest date any account needs, a day early so every time zone's date is covered.
    const froms = prepared.links.map((link) => {
      const since =
        link.last_line && link.last_ok ? (link.last_line < link.last_ok ? link.last_line : link.last_ok) : (link.last_line ?? link.last_ok);
      const overlap = since ? new Date(epochOf(since) * 1000 - OVERLAP_DAYS * DAY * 1000).toISOString().slice(0, 10) : link.start_date;
      return overlap > link.start_date ? overlap : link.start_date;
    });
    const end = Math.floor(Date.now() / 1000) + DAY;
    let start = froms.length ? Math.min(...froms.map(epochOf)) - DAY : end - DAY;
    if (!prepared.links.length) start = end - DAY;
    const windows: Array<[number, number]> = [];
    for (let from = start; from < end; from += MAX_DAYS_PER_REQUEST * DAY) windows.push([from, Math.min(from + MAX_DAYS_PER_REQUEST * DAY, end)]);
    for (const [from, to] of prepared.links.length ? windows : []) {
      if (prepared.used + requests >= limit)
        throw new ConflictError(`Stopped at SimpleFIN's daily limit after ${requests} requests; the next sync carries on.`);
      await withOrganisationTransaction(organisation, actor, (tx) =>
        tx.query("insert into simplefin_requests (connection_id) values ($1)", [prepared.connectionId]),
      );
      requests += 1;
      let set: SimpleFinAccountSet;
      try {
        set = await fetchAccounts(prepared.access, { start: from, end: to });
      } catch (caught) {
        throw simpleFinProblem(caught);
      }
      accountSet = set;
      problems.push(...set.problems);
      for (const account of set.accounts) {
        latest.set(account.id, account);
        // Each transaction once, even if two requests both returned it.
        const known = byAccount.get(account.id) ?? [];
        const ids = new Set(known.map((transaction) => transaction.id));
        byAccount.set(account.id, [
          ...known,
          ...(account.transactions ?? []).filter((transaction) => transaction.id == null || !ids.has(transaction.id)),
        ]);
      }
    }
  } catch (caught) {
    error = (caught instanceof Error ? caught.message : "The sync failed.").slice(0, 500);
  }

  const uniqueProblems = [...new Map(problems.map((problem) => [problemText(problem), problem])).values()];
  // Accounts whose lines arrived are added even when the Bridge reported a problem elsewhere (SF8).
  for (const link of prepared.links) {
    const account = latest.get(link.simplefin_account_id);
    const linkProblems = uniqueProblems.filter(
      (problem) => problem.accountId === link.simplefin_account_id || (problem.connectionId !== null && problem.connectionId === account?.conn_id),
    );
    let linkError = error ?? (linkProblems.length ? linkProblems.map(problemText).join(" ") : null);
    const skipped: Skip[] = [];
    const lines: ParsedStatementLine[] = [];
    if (!error && !account) {
      linkError ??= "SimpleFIN didn't return this account. It may have been removed in SimpleFIN Bridge.";
    } else if (account && account.currency !== link.currency_code) {
      linkError = `SimpleFIN now says this account is in ${account.currency}, not ${link.currency_code}; nothing was added.`;
    } else if (account) {
      const seen = new Set<string>();
      for (const transaction of byAccount.get(link.simplefin_account_id) ?? []) {
        const result = lineFromSimpleFin(link.simplefin_account_id, transaction, link.time_zone);
        if (!result) continue;
        if ("skip" in result) {
          skipped.push(result.skip);
          continue;
        }
        if (result.line.date < link.start_date || seen.has(result.line.externalId!)) continue;
        seen.add(result.line.externalId!);
        lines.push(result.line);
      }
    }
    totals.skipped += skipped.length;
    const balance = account && typeof account.balance === "string" && /^-?\d+(\.\d+)?$/.test(account.balance.trim()) ? account.balance.trim() : null;
    const balanceAt = account && typeof account["balance-date"] === "number" && account["balance-date"] > 0 ? account["balance-date"] : null;
    try {
      await withOrganisationTransaction(organisation, actor, async (tx) => {
        if (lines.length) {
          await lockStatementAccount(tx, link.account_id, "simplefin");
          const counts = await addStatementLines(tx, link.account_id, null, lines, { dryRun: true });
          if (counts.added > 0) {
            const inserted = await tx.query<{ id: string }>(
              `insert into bank_statement_imports (command_source, idempotency_key, request_hash, account_id, source, file_format,
                                                   line_count, duplicate_count, possible_duplicate_count, created_by_user_id, created_by_email)
               values ('simplefin', $1, 'feed', $2, 'simplefin', 'simplefin', $3, $4, $5, $6, $7) returning id`,
              [
                `${link.account_id}:${Date.now()}:${randomInt(1e9)}`,
                link.account_id,
                counts.added,
                counts.duplicates,
                counts.possibleDuplicates,
                tx.actor.userId,
                tx.actor.email,
              ],
            );
            await addStatementLines(tx, link.account_id, inserted.rows[0].id, lines);
            await writeAuditEvent(tx, {
              eventType: "bank_feed.simplefin_synced",
              entityType: "bank_statement_import",
              entityId: inserted.rows[0].id,
              details: {
                accountId: link.account_id,
                added: counts.added,
                duplicates: counts.duplicates,
                possibleDuplicates: counts.possibleDuplicates,
              },
            });
          }
          totals.added += counts.added;
          totals.duplicates += counts.duplicates;
          totals.possibleDuplicates += counts.possibleDuplicates;
        }
        if (balance !== null && account?.currency === link.currency_code) {
          await tx.query(
            `insert into bank_account_settings (account_id, statement_balance, statement_balance_at, updated_at)
             values ($1, $2::numeric, coalesce(to_timestamp($3::double precision), now()), now())
             on conflict (account_id) do update set statement_balance = excluded.statement_balance,
               statement_balance_at = excluded.statement_balance_at, updated_at = now()`,
            [link.account_id, balance, balanceAt],
          );
        }
        await tx.query(
          `update simplefin_links set last_synced_at = now(), last_sync_status = $2, last_sync_error = $3, last_skipped = $4::jsonb, updated_at = now()
            where account_id = $1`,
          [link.account_id, linkError ? "failed" : "ok", linkError, JSON.stringify(skipped.slice(0, MAX_SKIPPED))],
        );
      });
    } catch (caught) {
      const message = (caught instanceof Error ? caught.message : "The sync failed.").slice(0, 500);
      error ??= message;
      await withOrganisationTransaction(organisation, actor, (tx) =>
        tx.query(
          "update simplefin_links set last_synced_at = now(), last_sync_status = 'failed', last_sync_error = $2, updated_at = now() where account_id = $1",
          [link.account_id, message],
        ),
      ).catch(() => undefined);
    }
  }

  const status = error || uniqueProblems.length ? "failed" : "ok";
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query(
      `update simplefin_connections
          set last_synced_at = now(), last_sync_status = $2, last_sync_error = $3, last_problems = $4::jsonb, lease_until = null,
              accounts = coalesce($5::jsonb, accounts)
        where id = $1`,
      [
        prepared.connectionId,
        status,
        error,
        JSON.stringify(uniqueProblems.map(problemText)),
        accountSet ? JSON.stringify(storedAccounts(accountSet)) : null,
      ],
    );
  });
  return { status, requests, ...totals, error: error ?? (uniqueProblems.length ? uniqueProblems.map(problemText).join(" ") : null) };
}

/** Asks the Bridge for its account list again (no transactions), for linking a new account. Admins; counts towards the limit. */
export async function refreshSimpleFinAccounts(organisation: OrganisationRecord, actor: Actor, connectionId?: unknown): Promise<SimpleFinStatus> {
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    requireSecrets();
    const row = await activeConnection(tx, false, connectionId);
    if (!row) throw new ValidationError("SimpleFIN isn't connected.");
    const used = await requestsSince(tx);
    if (used.count >= MANUAL_REQUEST_LIMIT)
      throw new ConflictError(`Tohyee has asked SimpleFIN ${used.count} times in the last 24 hours. Try again later.`);
    await tx.query("insert into simplefin_requests (connection_id) values ($1)", [row.id]);
    return { id: row.id, access: decryptSecret(row.access_url_ciphertext) };
  });
  let set: SimpleFinAccountSet;
  try {
    set = await fetchAccounts(prepared.access, { balancesOnly: true });
  } catch (error) {
    throw simpleFinProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query("update simplefin_connections set accounts = $2::jsonb where id = $1", [prepared.id, JSON.stringify(storedAccounts(set))]);
    return getSimpleFinStatus(tx);
  });
}

let running = false;

/**
 * Syncs every organisation whose SimpleFIN connection is due (not synced
 * within its hours), in the quarter hour after its own random minute, as the
 * Bridge asks apps to spread their requests.
 */
export async function syncDueSimpleFin(now = new Date()): Promise<{ synced: number; failed: number }> {
  if (running || !secretsAvailable()) return { synced: 0, failed: 0 };
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let due: string[] = [];
      try {
        // Each login that's due, on its own (#182).
        due = await withOrganisationTransaction(organisation, FEED_ACTOR, async (tx) => {
          const ids: string[] = [];
          for (const row of await activeConnections(tx)) {
            const links = await tx.query(`select 1 from simplefin_links where active and connection_id = $1 and ${ACCOUNTING_ON_SQL} limit 1`, [row.id]);
            if (!links.rowCount) continue;
            const minute = (now.getUTCMinutes() - row.sync_minute + 60) % 60;
            const last = row.last_synced_at ? new Date(row.last_synced_at).getTime() : 0;
            // A few minutes' grace so a 6-hourly sync doesn't slip by a quarter hour each time.
            if (minute < 15 && now.getTime() - last >= row.sync_every_hours * 3_600_000 - 20 * 60_000) ids.push(row.id);
          }
          return ids;
        });
      } catch {
        continue;
      }
      for (const connectionId of due) {
        try {
          const result = await syncSimpleFin(organisation, FEED_ACTOR, { connectionId });
          if (result.status === "failed") failed += 1;
          else synced += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[tohyee] SimpleFIN sync failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return { synced, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Looks for due SimpleFIN syncs every 15 minutes while the server runs. */
export function startSimpleFinScheduler(): void {
  if (timer) return;
  const tick = () => {
    syncDueSimpleFin().catch((error) => console.warn("[tohyee] SimpleFIN scheduler:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 2 * 60 * 1000).unref?.();
}
