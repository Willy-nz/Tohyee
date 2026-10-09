import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import { randomInt } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { addStatementLines, lockStatementAccount } from "@/lib/bank/accounts";
import { FEED_ACTOR } from "@/lib/bank/akahu/sync";
import { makeLine, type ParsedStatementLine } from "@/lib/bank/formats/common";
import {
  fetchBalance,
  listBalanceTransactions,
  parseRestrictedKey,
  type StripeBalance,
  type StripeBalanceTransaction,
  stripeProblem,
} from "@/lib/bank/stripe/client";
import { businessTimeZone, parseIsoDate } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { CURRENCY_MINOR_UNITS } from "@/lib/money/currency";
import { toFixedString } from "@/lib/money/decimal";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { newLoginName, pickLogin } from "@/lib/bank/logins";
import { requireId } from "@/lib/validation";

/**
 * Stripe as a bank feed (ST1-ST10, decisions 392-395): the organisation's
 * Stripe balance is a bank account in Tohyee, and every balance transaction
 * becomes a line for its gross amount plus a line for each kind of fee. The
 * network calls happen between short database transactions, never inside one.
 */
export const DEFAULT_STRIPE_HOURS = 6;
const DAY = 86_400;

export type StripeBalanceOption = { currency: string; available: string; pending: string; linkedAccountId: string | null };

export type StripeConnectionStatus = {
  connected: boolean;
  /** The login (#182, BK30): its id and name; null when nothing is connected. */
  connectionId: string | null;
  name: string | null;
  keyHint: string | null;
  liveMode: boolean;
  syncEveryHours: number;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncError: string | null;
  balances: StripeBalanceOption[];
  createdAt: string | null;
  createdByEmail: string | null;
  secretsAvailable: boolean;
};

/** The first login's status (as before several logins), and every login's. */
export type StripeStatus = StripeConnectionStatus & { connections: StripeConnectionStatus[] };

export type StripeLink = {
  currencyCode: string;
  /** The login it syncs with (#182). */
  connectionId: string | null;
  loginName: string | null;
  startDate: string;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncError: string | null;
};

type ConnectionRow = {
  id: string;
  name: string;
  api_key_ciphertext: string;
  key_hint: string;
  live_mode: boolean;
  sync_every_hours: number;
  balances: StripeBalance;
  last_synced_at: string | null;
  last_sync_status: "never" | "ok" | "failed";
  last_sync_error: string | null;
  lease_until: string | null;
  created_at: string;
  created_by_email: string | null;
};

function requireSecrets(): void {
  if (!secretsAvailable()) {
    throw new UnavailableError(
      "This server has no TOHYEE_SECRET_KEY, so the Stripe key can't be stored safely. The server admin needs to set it (32+ random characters) and restart Tohyee.",
    );
  }
}

async function activeConnections(tx: OrgTx, lock = false): Promise<ConnectionRow[]> {
  const result = await tx.query<ConnectionRow>(
    `select id::text, name, api_key_ciphertext, key_hint, live_mode, sync_every_hours, balances, last_synced_at, last_sync_status, last_sync_error,
            lease_until, created_at, created_by_email
       from stripe_connections where status = 'active' order by stripe_connections.id ${lock ? "for update" : ""}`,
  );
  return result.rows;
}

/** The login a command is for (#182): the one chosen by `connectionId`, or the only one. */
async function activeConnection(tx: OrgTx, lock = false, connectionId?: unknown): Promise<ConnectionRow | null> {
  return pickLogin(await activeConnections(tx, lock), connectionId, "stripe");
}

function parseHours(input: unknown, fallback: number): number {
  if (input == null || input === "") return fallback;
  const hours = Number(input);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new ValidationError("Sync every must be 1 to 24 hours.");
  return hours;
}

/** An amount in a currency's smallest unit as a decimal string (cents to dollars), exactly. */
export function fromMinorUnits(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount)) throw new ValidationError("Stripe sent an amount that isn't a whole number of cents.");
  const places = CURRENCY_MINOR_UNITS[currency.toUpperCase()] ?? 2;
  return toFixedString({ units: BigInt(amount), scale: places }, places);
}

function dateIn(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(seconds * 1000));
}

export async function getStripeStatus(tx: OrgTx): Promise<StripeStatus> {
  const rows = await activeConnections(tx);
  const links = await tx.query<{ account_id: string; currency_code: string; connection_id: string | null }>(
    "select account_id::text, currency_code, connection_id::text from stripe_links where active",
  );
  const connections = rows.map((row) => connectionStatus(row, links.rows));
  return { ...(connections[0] ?? connectionStatus(null, [])), connections };
}

function connectionStatus(row: ConnectionRow | null, links: ReadonlyArray<{ account_id: string; currency_code: string; connection_id: string | null }>): StripeConnectionStatus {
  // One link per currency per login (#182).
  const linked = new Map(links.filter((link) => row !== null && link.connection_id === row.id).map((link) => [link.currency_code, link.account_id]));
  return {
    connected: row !== null,
    connectionId: row?.id ?? null,
    name: row?.name ?? null,
    keyHint: row?.key_hint ?? null,
    liveMode: row?.live_mode ?? true,
    syncEveryHours: row?.sync_every_hours ?? DEFAULT_STRIPE_HOURS,
    lastSyncedAt: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastSyncStatus: row?.last_sync_status ?? "never",
    lastSyncError: row?.last_sync_error ?? null,
    balances: (row?.balances ?? []).map((balance) => ({
      currency: balance.currency,
      available: fromMinorUnits(balance.available, balance.currency),
      pending: fromMinorUnits(balance.pending, balance.currency),
      linkedAccountId: linked.get(balance.currency) ?? null,
    })),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    createdByEmail: row?.created_by_email ?? null,
    secretsAvailable: secretsAvailable(),
  };
}

/**
 * Connects Stripe with a restricted key (ST1): checked by reading the
 * balance, then stored encrypted. Admins. One connection at a time.
 */
export async function connectStripe(
  organisation: OrganisationRecord,
  actor: Actor,
  input: { name?: unknown; apiKey?: unknown; syncEveryHours?: unknown },
): Promise<StripeStatus> {
  requireSecrets();
  const key = parseRestrictedKey(input.apiKey);
  const hours = parseHours(input.syncEveryHours, DEFAULT_STRIPE_HOURS);
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    // Several logins (#182): only the name must be new.
    await newLoginName(tx, "stripe", input.name);
  });
  let balances: StripeBalance;
  try {
    balances = await fetchBalance(key);
  } catch (error) {
    throw stripeProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query("lock table stripe_connections in share row exclusive mode");
    const name = await newLoginName(tx, "stripe", input.name);
    const hint = `${key.slice(0, 12)}…${key.slice(-4)}`;
    const inserted = await tx.query<{ id: string }>(
      `insert into stripe_connections (api_key_ciphertext, key_hint, live_mode, sync_every_hours, balances, created_by_email, name)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning id::text`,
      [encryptSecret(key), hint, key.startsWith("rk_live_"), hours, JSON.stringify(balances), tx.actor.email, name],
    );
    await writeAuditEvent(tx, {
      eventType: "bank_feed.stripe_connected",
      entityType: "stripe_connection",
      entityId: inserted.rows[0].id,
      details: { keyHint: hint, currencies: balances.map((balance) => balance.currency), syncEveryHours: hours },
    });
    return getStripeStatus(tx);
  });
}

/** Changes how often Stripe is synced (1-24 hours). Admins. */
export async function updateStripeSettings(tx: OrgTx, input: { syncEveryHours?: unknown; connectionId?: unknown }): Promise<StripeStatus> {
  const row = await activeConnection(tx, true, input.connectionId);
  if (!row) throw new NotFoundError("Stripe isn't connected.");
  const hours = parseHours(input.syncEveryHours, row.sync_every_hours);
  await tx.query("update stripe_connections set sync_every_hours = $2 where id = $1", [row.id, hours]);
  await writeAuditEvent(tx, {
    eventType: "bank_feed.stripe_updated",
    entityType: "stripe_connection",
    entityId: row.id,
    details: { syncEveryHours: hours },
  });
  return getStripeStatus(tx);
}

/** Disconnects (ST10): the stored key is deleted and every currency unlinked. Lines stay. Admins. */
export async function disconnectStripe(tx: OrgTx, connectionId?: unknown): Promise<StripeStatus> {
  const row = await activeConnection(tx, true, connectionId);
  if (!row) throw new NotFoundError("Stripe isn't connected.");
  if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("Stripe is syncing. Try again in a minute.");
  const unlinked = await tx.query(
    // Only this login's accounts (#182, BK35).
    "update stripe_links set active = false, connection_id = null, updated_at = now() where active and connection_id = $1",
    [row.id],
  );
  await tx.query(
    "update stripe_connections set status = 'removed', api_key_ciphertext = null, removed_at = now(), removed_by_email = $2 where id = $1",
    [row.id, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.stripe_disconnected",
    entityType: "stripe_connection",
    entityId: row.id,
    details: { unlinkedAccounts: unlinked.rowCount ?? 0 },
  });
  return getStripeStatus(tx);
}

/** The account's Stripe link, or null (viewers). */
export async function getStripeLink(tx: OrgTx, accountIdInput: unknown): Promise<StripeLink | null> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query<{
    currency_code: string;
    start_date: string;
    last_synced_at: string | null;
    last_sync_status: "never" | "ok" | "failed";
    last_sync_error: string | null;
    connection_id: string | null;
    login_name: string | null;
  }>(`select l.currency_code, l.start_date::text, l.last_synced_at, l.last_sync_status, l.last_sync_error, l.connection_id::text, c.name as login_name
       from stripe_links l left join stripe_connections c on c.id = l.connection_id where l.account_id = $1 and l.active`, [
    accountId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    loginName: row.login_name,
    currencyCode: row.currency_code,
    startDate: row.start_date,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
  };
}

/**
 * Links a Stripe balance currency to a bank account in that currency (ST2).
 * One feed per account: not with an Akahu or SimpleFIN feed. Admins.
 */
export async function linkStripeBalance(tx: OrgTx, accountIdInput: unknown, input: { currency?: unknown; startDate?: unknown; connectionId?: unknown }): Promise<StripeLink> {
  const accountId = requireId(accountIdInput, "accountId");
  if (typeof input.currency !== "string" || !/^[A-Za-z]{3}$/.test(input.currency)) throw new ValidationError("Choose Stripe's balance currency.");
  const currency = input.currency.toUpperCase();
  const startDate = parseIsoDate(input.startDate, "startDate");
  const connection = await activeConnection(tx, false, input.connectionId);
  if (!connection) throw new ValidationError("Connect Stripe first (Bank accounts → Stripe).");
  const account = await lockStatementAccount(tx, accountId, "stripe");
  if (currency !== account.currencyCode)
    throw new ValidationError(`Stripe's balance is in ${currency}; ${account.code} is in ${account.currencyCode}.`);
  const other = await tx.query<{ feed: string }>(
    `select 'Akahu' as feed from bank_account_settings where account_id = $1 and feed_active
     union all select 'SimpleFIN' from simplefin_links where account_id = $1 and active
     union all select 'PayPal' from paypal_links where account_id = $1 and active
     union all select 'Wise' from wise_links where account_id = $1 and active`,
    [accountId],
  );
  if (other.rows[0]) throw new ConflictError(`${account.code} already has a ${other.rows[0].feed} bank feed. Stop it first.`);
  const taken = await tx.query("select 1 from stripe_links where active and currency_code = $1 and account_id <> $2 and connection_id = $3", [
    currency,
    accountId,
    connection.id,
  ]);
  if (taken.rowCount) throw new ConflictError(`${connection.name}'s ${currency} balance is already linked to another bank account.`);
  await tx.query(
    `insert into stripe_links (account_id, connection_id, currency_code, start_date, active, created_by_email)
     values ($1, $2, $3, $4, true, $5)
     on conflict (account_id) do update set connection_id = excluded.connection_id, currency_code = excluded.currency_code,
       start_date = excluded.start_date, active = true, last_synced_at = null, last_sync_status = 'never', last_sync_error = null,
       created_by_email = excluded.created_by_email, updated_at = now()`,
    [accountId, connection.id, currency, startDate, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.stripe_linked",
    entityType: "account",
    entityId: accountId,
    details: { accountCode: account.code, currency, startDate },
  });
  return (await getStripeLink(tx, accountId))!;
}

/** Unlinks an account. Lines already brought in stay. Admins. */
export async function unlinkStripeBalance(tx: OrgTx, accountIdInput: unknown): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query("update stripe_links set active = false, connection_id = null, updated_at = now() where account_id = $1 and active", [
    accountId,
  ]);
  if (!result.rowCount) throw new NotFoundError("This account isn't linked to Stripe.");
  await writeAuditEvent(tx, { eventType: "bank_feed.stripe_unlinked", entityType: "account", entityId: accountId });
}

const TYPE_LABELS: Record<string, string> = {
  charge: "Charge",
  payment: "Charge",
  refund: "Refund",
  payment_refund: "Refund",
  payout: "Payout to bank",
  payout_cancel: "Payout cancelled",
  payout_failure: "Payout failed",
  stripe_fee: "Stripe fees",
  stripe_fx_fee: "Stripe currency conversion fee",
  tax_fee: "Stripe tax fee",
  application_fee: "Application fee",
  transfer: "Transfer",
  topup: "Top-up",
  adjustment: "Adjustment",
};

function label(transaction: StripeBalanceTransaction): string {
  if (transaction.reporting_category === "dispute") return "Dispute";
  if (transaction.reporting_category === "dispute_reversal") return "Dispute reversal";
  if (transaction.type === "payout") return "Payout to bank";
  const description = typeof transaction.description === "string" && transaction.description.trim() ? transaction.description.trim() : null;
  return (
    description ??
    TYPE_LABELS[transaction.type ?? ""] ??
    (transaction.type ?? "Stripe").replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase())
  );
}

/** "(USD 50.00 at 1.7)" for a charge Stripe converted into the balance currency (ST4). */
function conversion(transaction: StripeBalanceTransaction): string {
  const source = typeof transaction.source === "object" && transaction.source ? transaction.source : null;
  if (!transaction.exchange_rate || !source || typeof source.currency !== "string" || typeof source.amount !== "number") return "";
  if (source.currency.toLowerCase() === transaction.currency.toLowerCase()) return "";
  return ` (${source.currency.toUpperCase()} ${fromMinorUnits(source.amount, source.currency)} at ${transaction.exchange_rate})`;
}

/**
 * A balance transaction as statement lines (ST3-ST8): its gross amount, then
 * Stripe's fees, then any tax on the fees as its own line (ST7). Lines are
 * dated by `created` in the organisation's time zone.
 */
export function linesFromStripe(transaction: StripeBalanceTransaction, timeZone = businessTimeZone()): ParsedStatementLine[] {
  const currency = transaction.currency.toUpperCase();
  const date = dateIn(transaction.created, timeZone);
  const lines: ParsedStatementLine[] = [];
  if (transaction.amount !== 0) {
    lines.push(
      makeLine({
        date,
        amount: fromMinorUnits(transaction.amount, currency),
        description: `${label(transaction)}${conversion(transaction)}`,
        externalId: `stripe:${transaction.id}`,
      }),
    );
  }
  const details = (transaction.fee_details ?? []).filter((detail) => typeof detail.amount === "number" && detail.amount !== 0);
  const tax = details.filter((detail) => detail.type === "tax").reduce((total, detail) => total + (detail.amount as number), 0);
  const fees = (transaction.fee ?? 0) - tax;
  if (fees !== 0)
    lines.push(makeLine({ date, amount: fromMinorUnits(-fees, currency), description: "Stripe fees", externalId: `stripe:${transaction.id}:fee` }));
  if (tax !== 0)
    lines.push(
      makeLine({ date, amount: fromMinorUnits(-tax, currency), description: "Tax on Stripe fees", externalId: `stripe:${transaction.id}:tax` }),
    );
  return lines;
}

export type StripeSyncResult = { status: "ok" | "failed"; added: number; duplicates: number; possibleDuplicates: number; error: string | null };

type ActiveLink = { account_id: string; currency_code: string; start_date: string; last_line: string | null };

/**
 * Syncs every linked currency (ST3-ST9): the balance, then each currency's
 * balance transactions created since a day before its last line (or since
 * its start date), added as lines in one transaction per account.
 */
export async function syncStripe(organisation: OrganisationRecord, actor: Actor, options: { connectionId?: unknown } = {}): Promise<StripeSyncResult> {
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    requireSecrets();
    const row = await activeConnection(tx, true, options.connectionId);
    if (!row) throw new ValidationError("Stripe isn't connected. An admin can connect it under Bank accounts → Stripe.");
    if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("Stripe is already syncing.");
    await tx.query("update stripe_connections set lease_until = now() + interval '10 minutes' where id = $1", [row.id]);
    const links = await tx.query<ActiveLink>(
      `select l.account_id::text, l.currency_code, l.start_date::text,
              (select max(b.line_date)::text from bank_statement_lines b join bank_statement_imports i on i.id = b.import_id
                where b.account_id = l.account_id and i.source = 'stripe' and b.status <> 'deleted') as last_line
         from stripe_links l where l.active and l.connection_id = $1 order by l.account_id`,
      [row.id],
    );
    return { connectionId: row.id, key: decryptSecret(row.api_key_ciphertext), links: links.rows };
  });

  const totals = { added: 0, duplicates: 0, possibleDuplicates: 0 };
  let error: string | null = null;
  let balances: StripeBalance | null = null;
  try {
    balances = await fetchBalance(prepared.key);
  } catch (caught) {
    error = stripeProblem(caught).message.slice(0, 500);
  }
  const timeZone = businessTimeZone();
  for (const link of prepared.links) {
    let linkError = error;
    let lines: ParsedStatementLine[] = [];
    if (!linkError) {
      // A day early, so every line of the last day is seen again (and skipped if already here, BK2).
      const fromDate = link.last_line && link.last_line > link.start_date ? link.last_line : link.start_date;
      const since = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000) - DAY;
      try {
        const transactions = await listBalanceTransactions(prepared.key, link.currency_code, since);
        lines = transactions
          .filter((transaction) => transaction.currency.toUpperCase() === link.currency_code)
          .flatMap((transaction) => linesFromStripe(transaction, timeZone))
          .filter((line) => line.date >= link.start_date);
      } catch (caught) {
        linkError = stripeProblem(caught).message.slice(0, 500);
        error ??= linkError;
      }
    }
    const balance = balances?.find((entry) => entry.currency === link.currency_code) ?? null;
    try {
      await withOrganisationTransaction(organisation, actor, async (tx) => {
        if (lines.length) {
          await lockStatementAccount(tx, link.account_id, "stripe");
          const counts = await addStatementLines(tx, link.account_id, null, lines, { dryRun: true });
          if (counts.added > 0) {
            const inserted = await tx.query<{ id: string }>(
              `insert into bank_statement_imports (command_source, idempotency_key, request_hash, account_id, source, file_format,
                                                   line_count, duplicate_count, possible_duplicate_count, created_by_user_id, created_by_email)
               values ('stripe', $1, 'feed', $2, 'stripe', 'stripe', $3, $4, $5, $6, $7) returning id`,
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
              eventType: "bank_feed.stripe_synced",
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
        if (balance) {
          // Stripe's balance is available plus pending (ST9).
          await tx.query(
            `insert into bank_account_settings (account_id, statement_balance, statement_balance_at, updated_at)
             values ($1, $2::numeric, now(), now())
             on conflict (account_id) do update set statement_balance = excluded.statement_balance,
               statement_balance_at = excluded.statement_balance_at, updated_at = now()`,
            [link.account_id, fromMinorUnits(balance.available + balance.pending, balance.currency)],
          );
        }
        await tx.query(
          "update stripe_links set last_synced_at = now(), last_sync_status = $2, last_sync_error = $3, updated_at = now() where account_id = $1",
          [link.account_id, linkError ? "failed" : "ok", linkError],
        );
      });
    } catch (caught) {
      const message = (caught instanceof Error ? caught.message : "The sync failed.").slice(0, 500);
      error ??= message;
      await withOrganisationTransaction(organisation, actor, (tx) =>
        tx.query(
          "update stripe_links set last_synced_at = now(), last_sync_status = 'failed', last_sync_error = $2, updated_at = now() where account_id = $1",
          [link.account_id, message],
        ),
      ).catch(() => undefined);
    }
  }
  const status = error ? "failed" : "ok";
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query(
      `update stripe_connections set last_synced_at = now(), last_sync_status = $2, last_sync_error = $3, lease_until = null,
              balances = coalesce($4::jsonb, balances)
        where id = $1`,
      [prepared.connectionId, status, error, balances ? JSON.stringify(balances) : null],
    ),
  );
  return { status, ...totals, error };
}

let running = false;

/** Syncs every organisation whose Stripe connection is due (not synced within its hours). */
export async function syncDueStripe(): Promise<{ synced: number; failed: number }> {
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
        due = await withOrganisationTransaction(organisation, FEED_ACTOR, async (tx) =>
          (
            await tx.query<{ id: string }>(
              `select c.id::text from stripe_connections c
                where c.status = 'active' and exists (select 1 from stripe_links l where l.active and l.connection_id = c.id) and ${ACCOUNTING_ON_SQL}
                and (c.last_synced_at is null or c.last_synced_at < now() - make_interval(hours => c.sync_every_hours))
                and (c.lease_until is null or c.lease_until < now())
                order by c.id`,
            )
          ).rows.map((row) => row.id),
        );
      } catch {
        continue;
      }
      for (const connectionId of due) {
        try {
          const result = await syncStripe(organisation, FEED_ACTOR, { connectionId });
          if (result.status === "failed") failed += 1;
          else synced += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[tohyee] Stripe sync failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return { synced, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Looks for due Stripe syncs every 15 minutes while the server runs. */
export function startStripeScheduler(): void {
  if (timer) return;
  const tick = () => {
    syncDueStripe().catch((error) => console.warn("[tohyee] Stripe scheduler:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}
