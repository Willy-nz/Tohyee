import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import { randomInt } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { addStatementLines, lockStatementAccount } from "@/lib/bank/accounts";
import { FEED_ACTOR } from "@/lib/bank/akahu/sync";
import { makeLine, type ParsedStatementLine } from "@/lib/bank/formats/common";
import {
  fetchStatement,
  listBalances,
  listProfiles,
  MAX_DAYS_PER_REQUEST,
  money,
  parseToken,
  type WiseBalance,
  type WiseStatementTransaction,
  wiseProblem,
} from "@/lib/bank/wise/client";
import { businessTimeZone, parseIsoDate } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { add, cmp, dec, neg, sub, toFixedString } from "@/lib/money/decimal";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { requireId } from "@/lib/validation";

/**
 * Wise as a bank feed (WI1-WI10, decisions 400-403): each currency balance
 * of the organisation's Wise business account is a bank account in Tohyee,
 * and its balance statement arrives as lines, with Wise's fee split onto its
 * own line when Wise's running balance confirms how. The network calls
 * happen between short database transactions, never inside one.
 */
export const DEFAULT_WISE_HOURS = 6;
const OVERLAP_DAYS = 3;
const DAY_MS = 86_400_000;

export type WiseBalanceOption = WiseBalance & { linkedAccountId: string | null };

export type WiseStatus = {
  connected: boolean;
  profileId: number | null;
  profileName: string | null;
  syncEveryHours: number;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncError: string | null;
  balances: WiseBalanceOption[];
  createdAt: string | null;
  createdByEmail: string | null;
  secretsAvailable: boolean;
};

export type WiseLink = {
  currencyCode: string;
  startDate: string;
  lastSyncedAt: string | null;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncError: string | null;
};

type ConnectionRow = {
  id: string;
  token_ciphertext: string;
  profile_id: string;
  profile_name: string | null;
  sync_every_hours: number;
  balances: WiseBalance[];
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
      "This server has no TOHYEE_SECRET_KEY, so the Wise token can't be stored safely. The server admin needs to set it (32+ random characters) and restart Tohyee.",
    );
  }
}

async function activeConnection(tx: OrgTx, lock = false): Promise<ConnectionRow | null> {
  const result = await tx.query<ConnectionRow>(
    `select id::text, token_ciphertext, profile_id::text, profile_name, sync_every_hours, balances, last_synced_at, last_sync_status, last_sync_error,
            lease_until, created_at, created_by_email
       from wise_connections where status = 'active' ${lock ? "for update" : ""}`,
  );
  return result.rows[0] ?? null;
}

function parseHours(input: unknown, fallback: number): number {
  if (input == null || input === "") return fallback;
  const hours = Number(input);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new ValidationError("Sync every must be 1 to 24 hours.");
  return hours;
}

export async function getWiseStatus(tx: OrgTx): Promise<WiseStatus> {
  const row = await activeConnection(tx);
  const links = await tx.query<{ account_id: string; currency_code: string }>("select account_id::text, currency_code from wise_links where active");
  const linked = new Map(links.rows.map((link) => [link.currency_code, link.account_id]));
  return {
    connected: row !== null,
    profileId: row ? Number(row.profile_id) : null,
    profileName: row?.profile_name ?? null,
    syncEveryHours: row?.sync_every_hours ?? DEFAULT_WISE_HOURS,
    lastSyncedAt: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastSyncStatus: row?.last_sync_status ?? "never",
    lastSyncError: row?.last_sync_error ?? null,
    balances: (row?.balances ?? []).map((balance) => ({ ...balance, linkedAccountId: linked.get(balance.currency) ?? null })),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    createdByEmail: row?.created_by_email ?? null,
    secretsAvailable: secretsAvailable(),
  };
}

/** Connects Wise with a business account's personal token (WI1): its business profile and balances are read first. Admins. */
export async function connectWise(
  organisation: OrganisationRecord,
  actor: Actor,
  input: { token?: unknown; syncEveryHours?: unknown },
): Promise<WiseStatus> {
  requireSecrets();
  const token = parseToken(input.token);
  const hours = parseHours(input.syncEveryHours, DEFAULT_WISE_HOURS);
  await withOrganisationTransaction(organisation, actor, async (tx) => {
    if (await activeConnection(tx)) throw new ConflictError("Wise is already connected. Disconnect it first to use another token.");
  });
  let profile;
  let balances: WiseBalance[];
  try {
    profile = (await listProfiles(token)).find((entry) => entry.type === "BUSINESS");
    if (!profile) throw new ValidationError("That token has no Wise business profile. Make the token in the organisation's Wise business account.");
    balances = await listBalances(token, profile.id);
  } catch (error) {
    throw wiseProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    if (await activeConnection(tx, true)) throw new ConflictError("Wise is already connected. Disconnect it first to use another token.");
    const inserted = await tx.query<{ id: string }>(
      `insert into wise_connections (token_ciphertext, profile_id, profile_name, sync_every_hours, balances, created_by_email)
       values ($1, $2, $3, $4, $5::jsonb, $6) returning id::text`,
      [encryptSecret(token), profile.id, profile.name?.slice(0, 200) ?? null, hours, JSON.stringify(balances), tx.actor.email],
    );
    await writeAuditEvent(tx, {
      eventType: "bank_feed.wise_connected",
      entityType: "wise_connection",
      entityId: inserted.rows[0].id,
      details: { profileId: profile.id, currencies: balances.map((balance) => balance.currency), syncEveryHours: hours },
    });
    return getWiseStatus(tx);
  });
}

/** Changes how often Wise is synced (1-24 hours). Admins. */
export async function updateWiseSettings(tx: OrgTx, input: { syncEveryHours?: unknown }): Promise<WiseStatus> {
  const row = await activeConnection(tx, true);
  if (!row) throw new NotFoundError("Wise isn't connected.");
  const hours = parseHours(input.syncEveryHours, row.sync_every_hours);
  await tx.query("update wise_connections set sync_every_hours = $2 where id = $1", [row.id, hours]);
  await writeAuditEvent(tx, {
    eventType: "bank_feed.wise_updated",
    entityType: "wise_connection",
    entityId: row.id,
    details: { syncEveryHours: hours },
  });
  return getWiseStatus(tx);
}

/** Disconnects (WI10): the stored token is deleted and every currency unlinked. Lines stay. Admins. */
export async function disconnectWise(tx: OrgTx): Promise<WiseStatus> {
  const row = await activeConnection(tx, true);
  if (!row) throw new NotFoundError("Wise isn't connected.");
  if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("Wise is syncing. Try again in a minute.");
  const unlinked = await tx.query("update wise_links set active = false, connection_id = null, updated_at = now() where active");
  await tx.query("update wise_connections set status = 'removed', token_ciphertext = null, removed_at = now(), removed_by_email = $2 where id = $1", [
    row.id,
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, {
    eventType: "bank_feed.wise_disconnected",
    entityType: "wise_connection",
    entityId: row.id,
    details: { unlinkedAccounts: unlinked.rowCount ?? 0 },
  });
  return getWiseStatus(tx);
}

/** The account's Wise link, or null (viewers). */
export async function getWiseLink(tx: OrgTx, accountIdInput: unknown): Promise<WiseLink | null> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query<{
    currency_code: string;
    start_date: string;
    last_synced_at: string | null;
    last_sync_status: "never" | "ok" | "failed";
    last_sync_error: string | null;
  }>("select currency_code, start_date::text, last_synced_at, last_sync_status, last_sync_error from wise_links where account_id = $1 and active", [
    accountId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    currencyCode: row.currency_code,
    startDate: row.start_date,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
  };
}

/** Links a Wise currency balance to a bank account in that currency (WI2). One feed per account. Admins. */
export async function linkWiseBalance(tx: OrgTx, accountIdInput: unknown, input: { currency?: unknown; startDate?: unknown }): Promise<WiseLink> {
  const accountId = requireId(accountIdInput, "accountId");
  if (typeof input.currency !== "string" || !/^[A-Za-z]{3}$/.test(input.currency)) throw new ValidationError("Choose Wise's balance currency.");
  const currency = input.currency.toUpperCase();
  const startDate = parseIsoDate(input.startDate, "startDate");
  const connection = await activeConnection(tx);
  if (!connection) throw new ValidationError("Connect Wise first (Bank accounts → Wise).");
  const balance = connection.balances.find((entry) => entry.currency === currency);
  if (!balance) throw new ValidationError(`The Wise account has no ${currency} balance.`);
  const account = await lockStatementAccount(tx, accountId, "wise");
  if (currency !== account.currencyCode)
    throw new ValidationError(`Wise's balance is in ${currency}; ${account.code} is in ${account.currencyCode}.`);
  const other = await tx.query<{ feed: string }>(
    `select 'Akahu' as feed from bank_account_settings where account_id = $1 and feed_active
     union all select 'SimpleFIN' from simplefin_links where account_id = $1 and active
     union all select 'Stripe' from stripe_links where account_id = $1 and active
     union all select 'PayPal' from paypal_links where account_id = $1 and active`,
    [accountId],
  );
  if (other.rows[0]) throw new ConflictError(`${account.code} already has a ${other.rows[0].feed} feed. Stop it first.`);
  const taken = await tx.query("select 1 from wise_links where active and currency_code = $1 and account_id <> $2", [currency, accountId]);
  if (taken.rowCount) throw new ConflictError(`Wise's ${currency} balance is already linked to another bank account.`);
  await tx.query(
    `insert into wise_links (account_id, connection_id, balance_id, currency_code, start_date, active, created_by_email)
     values ($1, $2, $3, $4, $5, true, $6)
     on conflict (account_id) do update set connection_id = excluded.connection_id, balance_id = excluded.balance_id,
       currency_code = excluded.currency_code, start_date = excluded.start_date, active = true, last_synced_at = null,
       last_sync_status = 'never', last_sync_error = null, created_by_email = excluded.created_by_email, updated_at = now()`,
    [accountId, connection.id, balance.id, currency, startDate, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "bank_feed.wise_linked",
    entityType: "account",
    entityId: accountId,
    details: { accountCode: account.code, currency, startDate },
  });
  return (await getWiseLink(tx, accountId))!;
}

/** Unlinks an account. Lines already brought in stay. Admins. */
export async function unlinkWiseBalance(tx: OrgTx, accountIdInput: unknown): Promise<void> {
  const accountId = requireId(accountIdInput, "accountId");
  const result = await tx.query("update wise_links set active = false, connection_id = null, updated_at = now() where account_id = $1 and active", [
    accountId,
  ]);
  if (!result.rowCount) throw new NotFoundError("This account isn't linked to Wise.");
  await writeAuditEvent(tx, { eventType: "bank_feed.wise_unlinked", entityType: "account", entityId: accountId });
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const cents = (value: string) => toFixedString(dec(value), 2);

function describe(transaction: WiseStatementTransaction): string {
  const details = transaction.details ?? {};
  const kind = text(details.type);
  if (kind === "CARD") {
    const foreign = transaction.exchangeDetails?.forAmount;
    const amount = money(foreign?.value);
    const currency = text(foreign?.currency);
    const own = text(transaction.amount?.currency);
    return amount && currency && currency !== own ? `Card payment (${currency} ${cents(amount)})` : "Card payment";
  }
  if (kind === "CONVERSION") {
    const from = text(details.sourceAmount?.currency);
    const to = text(details.targetAmount?.currency);
    return from && to ? `Converted ${from} to ${to}` : "Currency conversion";
  }
  return (
    text(details.description) ??
    (kind === "DEPOSIT" || kind === "MONEY_ADDED" ? "Money received" : kind === "TRANSFER" ? "Transfer" : "Wise transaction")
  );
}

/**
 * A statement transaction as lines (WI3-WI8), given Wise's running balance
 * before it (or null when there's none to compare with). The fee is split
 * only when the running balance confirms whether the amount includes it.
 */
export function linesFromWise(
  transaction: WiseStatementTransaction,
  previousBalance: string | null,
  timeZone = businessTimeZone(),
): ParsedStatementLine[] {
  const reference = text(transaction.referenceNumber);
  const amountText = money(transaction.amount?.value);
  const at = text(transaction.date);
  if (!reference || !amountText || !at || Number.isNaN(Date.parse(at))) return [];
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  const amount = dec(amountText);
  const feeText = money(transaction.totalFees?.value);
  const fee = feeText ? dec(feeText) : null;
  const running = money(transaction.runningBalance?.value);
  const details = transaction.details ?? {};
  const payee = text(details.senderName) ?? text(details.merchant?.name);
  const base = {
    date,
    description: describe(transaction),
    payee,
    reference: text(details.paymentReference),
    balance: running ? cents(running) : null,
  };
  const lines: ParsedStatementLine[] = [];
  const hasFee = fee !== null && cmp(fee, dec("0")) !== 0;
  let main = amount;
  let split = false;
  let note: string | null = null;
  if (hasFee) {
    const moved = previousBalance !== null && running !== null ? sub(dec(running), dec(previousBalance)) : null;
    if (moved && cmp(moved, amount) === 0) {
      // The amount is the whole change, fee included: the line is the amount less the fee.
      main = add(amount, fee!);
      split = true;
    } else if (moved && cmp(moved, sub(amount, fee!)) === 0) {
      // The fee came off on top of the amount.
      split = true;
    } else {
      note = `Wise fee ${cents(feeText!)} not split: Wise's running balance couldn't confirm it`;
    }
  }
  if (cmp(main, dec("0")) !== 0) {
    lines.push(makeLine({ ...base, amount: toFixedString(main, 2), externalId: `wise:${reference}`, extra: note ? [note] : undefined }));
  }
  if (split)
    lines.push(
      makeLine({ date, amount: toFixedString(neg(fee!), 2), description: "Wise fees", balance: base.balance, externalId: `wise:${reference}:fee` }),
    );
  return lines;
}

export type WiseSyncResult = { status: "ok" | "failed"; added: number; duplicates: number; possibleDuplicates: number; error: string | null };

type ActiveLink = { account_id: string; balance_id: string; currency_code: string; start_date: string; last_line: string | null };

/**
 * Syncs every linked balance (WI3-WI9): each statement in 469-day pieces
 * from three days before its last line (or its start date), oldest first,
 * each transaction compared with the running balance before it.
 */
export async function syncWise(organisation: OrganisationRecord, actor: Actor, now = new Date()): Promise<WiseSyncResult> {
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    requireSecrets();
    const row = await activeConnection(tx, true);
    if (!row) throw new ValidationError("Wise isn't connected. An admin can connect it under Bank accounts → Wise.");
    if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("Wise is already syncing.");
    await tx.query("update wise_connections set lease_until = now() + interval '10 minutes' where id = $1", [row.id]);
    const links = await tx.query<ActiveLink>(
      `select l.account_id::text, l.balance_id::text, l.currency_code, l.start_date::text,
              (select max(b.line_date)::text from bank_statement_lines b join bank_statement_imports i on i.id = b.import_id
                where b.account_id = l.account_id and i.source = 'wise' and b.status <> 'deleted') as last_line
         from wise_links l where l.active and l.connection_id = $1 order by l.account_id`,
      [row.id],
    );
    return { connectionId: row.id, token: decryptSecret(row.token_ciphertext), profileId: Number(row.profile_id), links: links.rows };
  });

  const totals = { added: 0, duplicates: 0, possibleDuplicates: 0 };
  let error: string | null = null;
  let balances: WiseBalance[] | null = null;
  try {
    balances = await listBalances(prepared.token, prepared.profileId);
  } catch (caught) {
    error = wiseProblem(caught).message.slice(0, 500);
  }
  const timeZone = businessTimeZone();
  for (const link of prepared.links) {
    let linkError = error;
    const lines: ParsedStatementLine[] = [];
    let endBalance: string | null = null;
    if (!linkError) {
      const back = link.last_line
        ? new Date(Date.parse(`${link.last_line}T00:00:00Z`) - OVERLAP_DAYS * DAY_MS).toISOString().slice(0, 10)
        : link.start_date;
      const fromDate = back > link.start_date ? back : link.start_date;
      let from = Date.parse(`${fromDate}T00:00:00Z`) - DAY_MS;
      const transactions: WiseStatementTransaction[] = [];
      try {
        while (from < now.getTime()) {
          const to = Math.min(from + MAX_DAYS_PER_REQUEST * DAY_MS, now.getTime());
          const statement = await fetchStatement(
            prepared.token,
            prepared.profileId,
            Number(link.balance_id),
            link.currency_code,
            new Date(from),
            new Date(to),
          );
          transactions.push(...statement.transactions);
          endBalance = statement.endBalance ?? endBalance;
          from = to;
        }
      } catch (caught) {
        linkError = wiseProblem(caught).message.slice(0, 500);
        error ??= linkError;
      }
      // Oldest first, so each transaction can be compared with the running balance before it.
      const ordered = transactions
        .filter((transaction) => text(transaction.amount?.currency)?.toUpperCase() === link.currency_code)
        .map((transaction, index) => ({ transaction, index, at: Date.parse(String(transaction.date)) }))
        .sort((left, right) => left.at - right.at || left.index - right.index);
      const seen = new Set<string>();
      let previous: string | null = null;
      for (const { transaction } of ordered) {
        const reference = text(transaction.referenceNumber);
        if (reference && seen.has(reference)) continue;
        if (reference) seen.add(reference);
        // The first transaction fetched has no running balance before it to compare with.
        const made = linesFromWise(transaction, previous, timeZone);
        previous = money(transaction.runningBalance?.value);
        for (const line of made) if (line.date >= link.start_date) lines.push(line);
      }
    }
    const balance = balances?.find((entry) => entry.currency === link.currency_code) ?? null;
    try {
      await withOrganisationTransaction(organisation, actor, async (tx) => {
        if (lines.length) {
          await lockStatementAccount(tx, link.account_id, "wise");
          // A fee line only comes with its own transaction's line: if that came in earlier unsplit (WI8), its fee is in it already.
          const existing = new Set(
            (
              await tx.query<{ external_id: string }>(
                "select external_id from bank_statement_lines where account_id = $1 and external_id = any($2::text[]) and status <> 'deleted'",
                [link.account_id, lines.map((line) => line.externalId!)],
              )
            ).rows.map((row) => row.external_id),
          );
          const adding = lines.filter(
            (line) => !line.externalId!.endsWith(":fee") || !existing.has(line.externalId!.slice(0, -4)) || existing.has(line.externalId!),
          );
          lines.splice(0, lines.length, ...adding);
          const counts = await addStatementLines(tx, link.account_id, null, lines, { dryRun: true });
          if (counts.added > 0) {
            const inserted = await tx.query<{ id: string }>(
              `insert into bank_statement_imports (command_source, idempotency_key, request_hash, account_id, source, file_format,
                                                   line_count, duplicate_count, possible_duplicate_count, created_by_user_id, created_by_email)
               values ('wise', $1, 'feed', $2, 'wise', 'wise', $3, $4, $5, $6, $7) returning id`,
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
              eventType: "bank_feed.wise_synced",
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
        // Wise's balance: the statement's closing balance, or the balance list's (WI9).
        const statementBalance = endBalance ?? balance?.amount ?? null;
        if (statementBalance !== null && !linkError) {
          await tx.query(
            `insert into bank_account_settings (account_id, statement_balance, statement_balance_at, updated_at)
             values ($1, $2::numeric, now(), now())
             on conflict (account_id) do update set statement_balance = excluded.statement_balance,
               statement_balance_at = excluded.statement_balance_at, updated_at = now()`,
            [link.account_id, statementBalance],
          );
        }
        await tx.query(
          "update wise_links set last_synced_at = now(), last_sync_status = $2, last_sync_error = $3, updated_at = now() where account_id = $1",
          [link.account_id, linkError ? "failed" : "ok", linkError],
        );
      });
    } catch (caught) {
      const message = (caught instanceof Error ? caught.message : "The sync failed.").slice(0, 500);
      error ??= message;
      await withOrganisationTransaction(organisation, actor, (tx) =>
        tx.query(
          "update wise_links set last_synced_at = now(), last_sync_status = 'failed', last_sync_error = $2, updated_at = now() where account_id = $1",
          [link.account_id, message],
        ),
      ).catch(() => undefined);
    }
  }
  const status = error ? "failed" : "ok";
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query(
      `update wise_connections set last_synced_at = now(), last_sync_status = $2, last_sync_error = $3, lease_until = null,
              balances = coalesce($4::jsonb, balances)
        where id = $1`,
      [prepared.connectionId, status, error, balances ? JSON.stringify(balances) : null],
    ),
  );
  return { status, ...totals, error };
}

let running = false;

/** Syncs every organisation whose Wise connection is due (not synced within its hours). */
export async function syncDueWise(): Promise<{ synced: number; failed: number }> {
  if (running || !secretsAvailable()) return { synced: 0, failed: 0 };
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let due = false;
      try {
        due = await withOrganisationTransaction(organisation, FEED_ACTOR, async (tx) => {
          const result = await tx.query(
            `select 1 from wise_connections c
              where c.status = 'active' and exists (select 1 from wise_links l where l.active) and ${ACCOUNTING_ON_SQL}
                and (c.last_synced_at is null or c.last_synced_at < now() - make_interval(hours => c.sync_every_hours))
                and (c.lease_until is null or c.lease_until < now())`,
          );
          return (result.rowCount ?? 0) > 0;
        });
      } catch {
        continue;
      }
      if (!due) continue;
      try {
        const result = await syncWise(organisation, FEED_ACTOR);
        if (result.status === "failed") failed += 1;
        else synced += 1;
      } catch (error) {
        failed += 1;
        console.warn(`[tohyee] Wise sync failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { synced, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Looks for due Wise syncs every 15 minutes while the server runs. */
export function startWiseScheduler(): void {
  if (timer) return;
  const tick = () => {
    syncDueWise().catch((error) => console.warn("[tohyee] Wise scheduler:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 5 * 60 * 1000).unref?.();
}
