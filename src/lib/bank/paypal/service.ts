import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import { randomInt } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { addStatementLines, lockStatementAccount } from "@/lib/bank/accounts";
import { FEED_ACTOR } from "@/lib/bank/akahu/sync";
import { makeLine, type ParsedStatementLine } from "@/lib/bank/formats/common";
import {
  fetchBalances,
  getToken,
  listTransactions,
  MAX_DAYS_PER_REQUEST,
  parseCredentials,
  type PayPalBalance,
  type PayPalTransaction,
  payPalProblem,
} from "@/lib/bank/paypal/client";
import { parseIsoDate } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { newLoginName, pickLogin } from "@/lib/bank/logins";
import { requireId } from "@/lib/validation";

/**
 * PayPal as a bank feed (PP1-PP10, decisions 396-399): the organisation's
 * PayPal balance is a bank account in Tohyee, and every completed
 * transaction becomes a line for its gross amount plus a line for its fee.
 * The network calls happen between short database transactions, never
 * inside one.
 */
export const DEFAULT_PAYPAL_HOURS = 6;
/** PayPal says a transaction can take up to three hours to appear; later syncs look back three days. */
const OVERLAP_DAYS = 3;
const DAY_MS = 86_400_000;

export type PayPalBalanceOption = PayPalBalance & { linkedAccountId: string | null };

export type PayPalConnectionStatus = {
  connected: boolean;
  /** The login (#182, BK30): its id and name; null when nothing is connected. */
  connectionId: string | null;
  name: string | null;
  clientId: string | null;
  syncEveryHours: number;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncError: string | null;
  balances: PayPalBalanceOption[];
  createdAt: string | null;
  createdByEmail: string | null;
  secretsAvailable: boolean;
};

/** The first login's status (as before several logins), and every login's. */
export type PayPalStatus = PayPalConnectionStatus & { connections: PayPalConnectionStatus[] };

export type PayPalLink = {
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
  client_id: string;
  client_secret_ciphertext: string;
  sync_every_hours: number;
  balances: PayPalBalance[];
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
      "This server has no TOHYEE_SECRET_KEY, so the PayPal secret can't be stored safely. The server admin needs to set it (32+ random characters) and restart Tohyee.",
    );
  }
}

async function activeConnections(tx: OrgTx, lock = false): Promise<ConnectionRow[]> {
  const result = await tx.query<ConnectionRow>(
    `select id::text, name, client_id, client_secret_ciphertext, sync_every_hours, balances, last_synced_at, last_sync_status, last_sync_error,
            lease_until, created_at, created_by_email
       from paypal_connections where status = 'active' order by paypal_connections.id ${lock ? "for update" : ""}`,
  );
  return result.rows;
}

/** The login a command is for (#182): the one chosen by `connectionId`, or the only one. */
async function activeConnection(tx: OrgTx, lock = false, connectionId?: unknown): Promise<ConnectionRow | null> {
  return pickLogin(await activeConnections(tx, lock), connectionId, "paypal");
}

function parseHours(input: unknown, fallback: number): number {
  if (input == null || input === "") return fallback;
  const hours = Number(input);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new ValidationError("Sync every must be 1 to 24 hours.");
  return hours;
}

export async function getPayPalStatus(tx: OrgTx): Promise<PayPalStatus> {
  const rows = await activeConnections(tx);
  const links = await tx.query<{ account_id: string; currency_code: string; connection_id: string | null }>(
    "select account_id::text, currency_code, connection_id::text from paypal_links where active",
  );
  const connections = rows.map((row) => connectionStatus(row, links.rows));
  return { ...(connections[0] ?? connectionStatus(null, [])), connections };
}

function connectionStatus(row: ConnectionRow | null, links: ReadonlyArray<{ account_id: string; currency_code: string; connection_id: string | null }>): PayPalConnectionStatus {
  // One link per currency per login (#182).
  const linked = new Map(links.filter((link) => row !== null && link.connection_id === row.id).map((link) => [link.currency_code, link.account_id]));
  return {
    connected: row !== null,
    connectionId: row?.id ?? null,
    name: row?.name ?? null,
    clientId: row?.client_id ?? null,
    syncEveryHours: row?.sync_every_hours ?? DEFAULT_PAYPAL_HOURS,
    lastSyncedAt: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastSyncStatus: row?.last_sync_status ?? "never",
    lastSyncError: row?.last_sync_error ?? null,
    balances: (row?.balances ?? []).map((balance) => ({ ...balance, linkedAccountId: linked.get(balance.currency) ?? null })),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    createdByEmail: row?.created_by_email ?? null,
    secretsAvailable: secretsAvailable(),
  };
}

/** Connects PayPal with the live app's client ID and secret (PP1): a token and the balances are read first, then the secret is stored encrypted. Admins. */
export async function connectPayPal(
  organisation: OrganisationRecord,
  actor: Actor,
  input: { name?: unknown; clientId?: unknown; clientSecret?: unknown; syncEveryHours?: unknown },
): Promise<PayPalStatus> {
  requireSecrets();
  const credentials = parseCredentials(input);
  const hours = parseHours(input.syncEveryHours, DEFAULT_PAYPAL_HOURS);
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    // Several logins (#182): only the name must be new.
    await newLoginName(tx, "paypal", input.name);
  });
  let balances: PayPalBalance[];
  try {
    balances = await fetchBalances(await getToken(credentials));
  } catch (error) {
    throw payPalProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query("lock table paypal_connections in share row exclusive mode");
    const name = await newLoginName(tx, "paypal", input.name);
    const inserted = await tx.query<{ id: string }>(
      `insert into paypal_connections (client_id, client_secret_ciphertext, sync_every_hours, balances, created_by_email, name)
       values ($1, $2, $3, $4::jsonb, $5, $6) returning id::text`,
      [credentials.clientId, encryptSecret(credentials.clientSecret), hours, JSON.stringify(balances), tx.actor.email, name],
    );
    await writeAuditEvent(tx, {
      eventType: "bank_feed.paypal_connected",
      entityType: "paypal_connection",
      entityId: inserted.rows[0].id,
      details: { clientId: credentials.clientId, currencies: balances.map((balance) => balance.currency), syncEveryHours: hours },
    });
    return getPayPalStatus(tx);
  });
}

/** Changes how often PayPal is synced (1-24 hours). Admins. */
export async function updatePayPalSettings(tx: OrgTx, input: { syncEveryHours?: unknown; connectionId?: unknown }): Promise<PayPalStatus> {
  const row = await activeConnection(tx, true, input.connectionId);
  if (!row) throw new NotFoundError("PayPal isn't connected.");
  const hours = parseHours(input.syncEveryHours, row.sync_every_hours);
  await tx.query("update paypal_connections set sync_every_hours = $2 where id = $1", [row.id, hours]);
  await writeAuditEvent(tx, {
    eventType: "bank_feed.paypal_updated",
    entityType: "paypal_connection",
    entityId: row.id,
    details: { syncEveryHours: hours },
  });
  return getPayPalStatus(tx);
}

/** Disconnects (PP10): the stored secret is deleted and every currency unlinked. Lines stay. Admins. */
export async function disconnectPayPal(tx: OrgTx, connectionId?: unknown): Promise<PayPalStatus> {
  const row = await activeConnection(tx, true, connectionId);
  if (!row) throw new NotFoundError("PayPal isn't connected.");
  if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("PayPal is syncing. Try again in a minute.");
  const unlinked = await tx.query(
    // Only this login's accounts (#182, BK35).
    "update paypal_links set active = false, connection_id = null, updated_at = now() where active and connection_id = $1",
    [row.id],
  );
  await tx.query(
    "update paypal_connections set status = 'removed', client_secret_ciphertext = null, removed_at = now(), removed_by_email = $2 where id = $1",
    [row.id, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.paypal_disconnected",
    entityType: "paypal_connection",
    entityId: row.id,
    details: { unlinkedAccounts: unlinked.rowCount ?? 0 },
  });
  return getPayPalStatus(tx);
}

/** The account's PayPal link, or null (viewers). */
export async function getPayPalLink(tx: OrgTx, accountIdInput: unknown): Promise<PayPalLink | null> {
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
       from paypal_links l left join paypal_connections c on c.id = l.connection_id where l.account_id = $1 and l.active`, [
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

/** Links a PayPal balance currency to a bank account in that currency (PP2). One feed per account. Admins. */
export async function linkPayPalBalance(tx: OrgTx, accountIdInput: unknown, input: { currency?: unknown; startDate?: unknown; connectionId?: unknown }): Promise<PayPalLink> {
  const accountId = requireId(accountIdInput, "accountId");
  if (typeof input.currency !== "string" || !/^[A-Za-z]{3}$/.test(input.currency)) throw new ValidationError("Choose PayPal's balance currency.");
  const currency = input.currency.toUpperCase();
  const startDate = parseIsoDate(input.startDate, "startDate");
  const connection = await activeConnection(tx, false, input.connectionId);
  if (!connection) throw new ValidationError("Connect PayPal first (Bank accounts → PayPal).");
  const account = await lockStatementAccount(tx, accountId, "paypal");
  if (currency !== account.currencyCode)
    throw new ValidationError(`PayPal's balance is in ${currency}; ${account.code} is in ${account.currencyCode}.`);
  const other = await tx.query<{ feed: string }>(
    `select 'Akahu' as feed from bank_account_settings where account_id = $1 and feed_active
     union all select 'SimpleFIN' from simplefin_links where account_id = $1 and active
     union all select 'Stripe' from stripe_links where account_id = $1 and active
     union all select 'Wise' from wise_links where account_id = $1 and active`,
    [accountId],
  );
  if (other.rows[0]) throw new ConflictError(`${account.code} already has a ${other.rows[0].feed} feed. Stop it first.`);
  const taken = await tx.query("select 1 from paypal_links where active and currency_code = $1 and account_id <> $2 and connection_id = $3", [
    currency,
    accountId,
    connection.id,
  ]);
  if (taken.rowCount) throw new ConflictError(`${connection.name}'s ${currency} balance is already linked to another bank account.`);
  await tx.query(
    `insert into paypal_links (account_id, connection_id, currency_code, start_date, active, created_by_email)
     values ($1, $2, $3, $4, true, $5)
     on conflict (account_id) do update set connection_id = excluded.connection_id, currency_code = excluded.currency_code,
       start_date = excluded.start_date, active = true, last_synced_at = null, last_sync_status = 'never', last_sync_error = null,
       created_by_email = excluded.created_by_email, updated_at = now()`,
    [accountId, connection.id, currency, startDate, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.paypal_linked",
    entityType: "account",
    entityId: accountId,
    details: { accountCode: account.code, currency, startDate },
  });
  return (await getPayPalLink(tx, accountId))!;
}

/** Unlinks an account. Lines already brought in stay. Admins. */
export async function unlinkPayPalBalance(tx: OrgTx, accountIdInput: unknown): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query("update paypal_links set active = false, connection_id = null, updated_at = now() where account_id = $1 and active", [
    accountId,
  ]);
  if (!result.rowCount) throw new NotFoundError("This account isn't linked to PayPal.");
  await writeAuditEvent(tx, { eventType: "bank_feed.paypal_unlinked", entityType: "account", entityId: accountId });
}

/** What an event code means, for a line with no subject (PayPal's transaction event code reference). */
export function eventLabel(code: string): string {
  if (code === "T0106") return "Chargeback fee";
  if (code === "T0200") return "Currency conversion";
  if (code === "T1107") return "Refund";
  if (code === "T1201") return "Chargeback";
  const group = code.slice(0, 3);
  const labels: Record<string, string> = {
    T00: "Payment",
    T01: "PayPal fee",
    T02: "Transfer or hold",
    T03: "Deposit",
    T04: "Withdrawal to bank",
    T05: "PayPal debit card",
    T07: "Credit card",
    T09: "Incentive",
    T11: "Reversal",
    T12: "Adjustment",
    T15: "Hold",
    T19: "Correction",
  };
  return labels[group] ?? "PayPal transaction";
}

const MONEY = /^-?\d+(\.\d{1,2})?$/;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * A PayPal transaction as statement lines (PP3-PP8): its gross amount and,
 * when there's one, its fee with PayPal's sign. Pending and denied ones give
 * none; the date is PayPal's own (the account's time zone).
 */
export function linesFromPayPal(transaction: PayPalTransaction): ParsedStatementLine[] {
  const info = transaction.transaction_info ?? {};
  const id = text(info.transaction_id);
  const status = text(info.transaction_status);
  const dateText = text(info.transaction_initiation_date);
  if (!id || !dateText || (status !== "S" && status !== "V")) return [];
  const date = dateText.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const gross = text(info.transaction_amount?.value);
  const fee = text(info.fee_amount?.value);
  const code = text(info.transaction_event_code) ?? "";
  const name = transaction.payer_info?.payer_name;
  const payer = text(name?.alternate_full_name) ?? ([text(name?.given_name), text(name?.surname)].filter(Boolean).join(" ") || null);
  const lines: ParsedStatementLine[] = [];
  const toCents = (value: string) => (value.includes(".") ? value.padEnd(value.indexOf(".") + 3, "0") : `${value}.00`);
  if (gross && MONEY.test(gross) && !/^-?0+(\.0+)?$/.test(gross)) {
    lines.push(
      makeLine({
        date,
        amount: toCents(gross),
        description: text(info.transaction_subject) ?? eventLabel(code),
        payee: payer,
        reference: text(info.invoice_id),
        externalId: `paypal:${id}`,
      }),
    );
  }
  if (fee && MONEY.test(fee) && !/^-?0+(\.0+)?$/.test(fee)) {
    lines.push(makeLine({ date, amount: toCents(fee), description: "PayPal fees", externalId: `paypal:${id}:fee` }));
  }
  return lines;
}

export type PayPalSyncResult = { status: "ok" | "failed"; added: number; duplicates: number; possibleDuplicates: number; error: string | null };

type ActiveLink = { account_id: string; currency_code: string; start_date: string; last_line: string | null };

/**
 * Syncs every linked currency (PP3-PP9): the balances, then each currency's
 * transactions in 31-day pieces from three days before its last line (or its
 * start date), added as lines in one transaction per account.
 */
export async function syncPayPal(
  organisation: OrganisationRecord,
  actor: Actor,
  now = new Date(),
  options: { connectionId?: unknown } = {},
): Promise<PayPalSyncResult> {
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    requireSecrets();
    const row = await activeConnection(tx, true, options.connectionId);
    if (!row) throw new ValidationError("PayPal isn't connected. An admin can connect it under Bank accounts → PayPal.");
    if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("PayPal is already syncing.");
    await tx.query("update paypal_connections set lease_until = now() + interval '10 minutes' where id = $1", [row.id]);
    const links = await tx.query<ActiveLink>(
      `select l.account_id::text, l.currency_code, l.start_date::text,
              (select max(b.line_date)::text from bank_statement_lines b join bank_statement_imports i on i.id = b.import_id
                where b.account_id = l.account_id and i.source = 'paypal' and b.status <> 'deleted') as last_line
         from paypal_links l where l.active and l.connection_id = $1 order by l.account_id`,
      [row.id],
    );
    return {
      connectionId: row.id,
      credentials: { clientId: row.client_id, clientSecret: decryptSecret(row.client_secret_ciphertext) },
      links: links.rows,
    };
  });

  const totals = { added: 0, duplicates: 0, possibleDuplicates: 0 };
  let error: string | null = null;
  let token: string | null = null;
  let balances: PayPalBalance[] | null = null;
  try {
    token = await getToken(prepared.credentials);
    balances = await fetchBalances(token);
  } catch (caught) {
    error = payPalProblem(caught).message.slice(0, 500);
  }
  for (const link of prepared.links) {
    let linkError = error;
    const lines: ParsedStatementLine[] = [];
    if (!linkError && token) {
      const back = link.last_line
        ? new Date(Date.parse(`${link.last_line}T00:00:00Z`) - OVERLAP_DAYS * DAY_MS).toISOString().slice(0, 10)
        : link.start_date;
      const fromDate = back > link.start_date ? back : link.start_date;
      // A day early, so the start date is covered whatever the PayPal account's time zone.
      let from = Date.parse(`${fromDate}T00:00:00Z`) - DAY_MS;
      const seen = new Set<string>();
      try {
        while (from < now.getTime()) {
          const to = Math.min(from + MAX_DAYS_PER_REQUEST * DAY_MS, now.getTime());
          for (const transaction of await listTransactions(token, link.currency_code, new Date(from), new Date(to))) {
            if (text(transaction.transaction_info?.transaction_amount?.currency_code)?.toUpperCase() !== link.currency_code) continue;
            for (const line of linesFromPayPal(transaction)) {
              if (line.date < link.start_date || seen.has(line.externalId!)) continue;
              seen.add(line.externalId!);
              lines.push(line);
            }
          }
          from = to;
        }
      } catch (caught) {
        linkError = payPalProblem(caught).message.slice(0, 500);
        error ??= linkError;
      }
    }
    const balance = balances?.find((entry) => entry.currency === link.currency_code) ?? null;
    try {
      await withOrganisationTransaction(organisation, actor, async (tx) => {
        if (lines.length) {
          await lockStatementAccount(tx, link.account_id, "paypal");
          const counts = await addStatementLines(tx, link.account_id, null, lines, { dryRun: true });
          if (counts.added > 0) {
            const inserted = await tx.query<{ id: string }>(
              `insert into bank_statement_imports (command_source, idempotency_key, request_hash, account_id, source, file_format,
                                                   line_count, duplicate_count, possible_duplicate_count, created_by_user_id, created_by_email)
               values ('paypal', $1, 'feed', $2, 'paypal', 'paypal', $3, $4, $5, $6, $7) returning id`,
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
              eventType: "bank_feed.paypal_synced",
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
          // PayPal's total balance for the currency (PP9).
          await tx.query(
            `insert into bank_account_settings (account_id, statement_balance, statement_balance_at, updated_at)
             values ($1, $2::numeric, now(), now())
             on conflict (account_id) do update set statement_balance = excluded.statement_balance,
               statement_balance_at = excluded.statement_balance_at, updated_at = now()`,
            [link.account_id, balance.total],
          );
        }
        await tx.query(
          "update paypal_links set last_synced_at = now(), last_sync_status = $2, last_sync_error = $3, updated_at = now() where account_id = $1",
          [link.account_id, linkError ? "failed" : "ok", linkError],
        );
      });
    } catch (caught) {
      const message = (caught instanceof Error ? caught.message : "The sync failed.").slice(0, 500);
      error ??= message;
      await withOrganisationTransaction(organisation, actor, (tx) =>
        tx.query(
          "update paypal_links set last_synced_at = now(), last_sync_status = 'failed', last_sync_error = $2, updated_at = now() where account_id = $1",
          [link.account_id, message],
        ),
      ).catch(() => undefined);
    }
  }
  const status = error ? "failed" : "ok";
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query(
      `update paypal_connections set last_synced_at = now(), last_sync_status = $2, last_sync_error = $3, lease_until = null,
              balances = coalesce($4::jsonb, balances)
        where id = $1`,
      [prepared.connectionId, status, error, balances ? JSON.stringify(balances) : null],
    ),
  );
  return { status, ...totals, error };
}

let running = false;

/** Syncs every organisation whose PayPal connection is due (not synced within its hours). */
export async function syncDuePayPal(): Promise<{ synced: number; failed: number }> {
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
              `select c.id::text from paypal_connections c
                where c.status = 'active' and exists (select 1 from paypal_links l where l.active and l.connection_id = c.id) and ${ACCOUNTING_ON_SQL}
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
          const result = await syncPayPal(organisation, FEED_ACTOR, new Date(), { connectionId });
          if (result.status === "failed") failed += 1;
          else synced += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[tohyee] PayPal sync failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return { synced, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Looks for due PayPal syncs every 15 minutes while the server runs. */
export function startPayPalScheduler(): void {
  if (timer) return;
  const tick = () => {
    syncDuePayPal().catch((error) => console.warn("[tohyee] PayPal scheduler:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 4 * 60 * 1000).unref?.();
}
