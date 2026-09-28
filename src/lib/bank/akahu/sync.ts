import { addStatementLines, lockStatementAccount } from "@/lib/bank/accounts";
import {
  akahuProblem,
  listAkahuAccounts,
  listAkahuTransactions,
  refreshAkahuAccount,
  type AkahuTransaction,
} from "@/lib/bank/akahu/client";
import { akahuCredentialsForAccount } from "@/lib/bank/akahu/settings";
import { makeLine, type ParsedStatementLine } from "@/lib/bank/formats/common";
import { writeAuditEvent } from "@/lib/audit";
import { businessTimeZone } from "@/lib/dates";
import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { listAllOrganisations } from "@/lib/organisations/admin";
import { secretsAvailable } from "@/lib/secrets";
import type { OrganisationRecord } from "@/lib/organisations/registry";

/**
 * Bank feed syncs (examples BK15, BK16): read settled transactions from Akahu
 * for a linked account and add the new ones as statement lines. The network
 * calls happen between two short database transactions, never inside one.
 */
export const FEED_ACTOR: Actor = { userId: null, email: "bank-feed@tohyee" };

function nzDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: businessTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

function dayBefore(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

/** An Akahu transaction as a statement line (money out is negative on both sides). */
export function lineFromAkahu(transaction: AkahuTransaction): ParsedStatementLine {
  return makeLine({
    date: nzDate(transaction.date),
    amount: transaction.amount.toFixed(2),
    description: transaction.description,
    payee: transaction.merchant?.name ?? null,
    particulars: transaction.meta?.particulars ?? null,
    code: transaction.meta?.code ?? null,
    reference: transaction.meta?.reference ?? null,
    balance: typeof transaction.balance === "number" ? transaction.balance.toFixed(2) : null,
    externalId: `akahu:${transaction._id}`,
  });
}

export type SyncResult = { added: number; duplicates: number; possibleDuplicates: number; syncedAt: string };

/** Syncs one linked account. Failures are kept on the account and rethrown. */
export async function syncBankFeedAccount(
  organisation: OrganisationRecord,
  accountId: string,
  actor: Actor = FEED_ACTOR,
  options: { refresh?: boolean } = {},
): Promise<SyncResult> {
  try {
    const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
      const link = await akahuCredentialsForAccount(tx, accountId);
      const last = await tx.query<{ last: string | null }>(
        `select max(b.line_date)::text as last from bank_statement_lines b join bank_statement_imports i on i.id = b.import_id
          where b.account_id = $1 and i.source = 'akahu' and b.status <> 'deleted'`,
        [accountId],
      );
      return { ...link, lastFeedDate: last.rows[0]?.last ?? null };
    });
    if (options.refresh) await refreshAkahuAccount(prepared.credentials, prepared.akahuAccountId);
    const from = prepared.lastFeedDate && prepared.lastFeedDate > prepared.startDate ? prepared.lastFeedDate : prepared.startDate;
    const [transactions, accounts] = await Promise.all([
      listAkahuTransactions(prepared.credentials, prepared.akahuAccountId, `${dayBefore(dayBefore(from))}T00:00:00.000Z`),
      listAkahuAccounts(prepared.credentials),
    ]);
    const lines = transactions.map(lineFromAkahu).filter((line) => line.date >= prepared.startDate);
    const akahuAccount = accounts.find((account) => account._id === prepared.akahuAccountId);
    const balance = typeof akahuAccount?.balance?.current === "number" ? akahuAccount.balance.current : null;
    // Akahu reports a credit card's balance as what's owed; statement lines count what's owed as negative.
    const isCard = akahuAccount?.type === "CREDITCARD";
    return await withOrganisationTransaction(organisation, actor, async (tx) => {
      await lockStatementAccount(tx, accountId);
      const counts = await addStatementLines(tx, accountId, null, lines, { dryRun: true });
      if (counts.added > 0) {
        const inserted = await tx.query<{ id: string }>(
          `insert into bank_statement_imports (command_source, idempotency_key, request_hash, account_id, source, file_format,
                                               line_count, duplicate_count, possible_duplicate_count, created_by_email)
           values ('akahu', $1, 'feed', $2, 'akahu', 'akahu', $3, $4, $5, $6) returning id`,
          [`${accountId}:${Date.now()}:${Math.random().toString(36).slice(2)}`, accountId, counts.added, counts.duplicates, counts.possibleDuplicates, actor.email],
        );
        await addStatementLines(tx, accountId, inserted.rows[0].id, lines);
        await writeAuditEvent(tx, {
          eventType: "bank_feed.synced",
          entityType: "bank_statement_import",
          entityId: inserted.rows[0].id,
          details: { accountId, added: counts.added, duplicates: counts.duplicates },
        });
      }
      const synced = await tx.query<{ at: string }>(
        `update bank_account_settings
            set last_synced_at = now(), last_sync_status = 'ok', last_sync_error = null,
                statement_balance = coalesce($2::numeric, statement_balance),
                statement_balance_at = case when $2::numeric is null then statement_balance_at else now() end,
                updated_at = now()
          where account_id = $1
          returning last_synced_at as at`,
        [accountId, balance === null ? null : (isCard ? -Math.abs(balance) : balance).toFixed(2)],
      );
      return { ...counts, syncedAt: synced.rows[0].at };
    });
  } catch (error) {
    const problem = akahuProblem(error);
    try {
      await withOrganisationTransaction(organisation, actor, (tx) =>
        tx.query(
          `update bank_account_settings set last_synced_at = now(), last_sync_status = 'failed', last_sync_error = $2, updated_at = now()
            where account_id = $1`,
          [accountId, problem.message.slice(0, 500)],
        ),
      );
    } catch {
      // The failure itself is what matters; it's rethrown below.
    }
    throw problem;
  }
}

let running = false;

/**
 * Syncs every linked account on the server that's due (not synced within its
 * organisation's "sync every" hours), one at a time. Organisations without
 * Akahu tokens have no active feeds that can sync, and are skipped.
 */
export async function syncDueBankFeeds(): Promise<{ synced: number; failed: number }> {
  if (running || !secretsAvailable()) return { synced: 0, failed: 0 };
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let due: string[] = [];
      try {
        due = await withOrganisationTransaction(organisation, FEED_ACTOR, async (tx) =>
          (
            await tx.query<{ account_id: string }>(
              `select s.account_id
                 from bank_account_settings s
                 join akahu_connections c on c.status = 'active'
                where s.feed_active
                  and (s.last_synced_at is null or s.last_synced_at < now() - make_interval(hours => c.sync_every_hours))
                order by s.last_synced_at nulls first`,
            )
          ).rows.map((row) => row.account_id),
        );
      } catch {
        continue;
      }
      for (const accountId of due) {
        try {
          await syncBankFeedAccount(organisation, accountId);
          synced += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[tohyee] Bank feed sync failed for ${organisation.id} account ${accountId}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    return { synced, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks for due bank feeds every 15 minutes while the server runs. */
export function startBankFeedScheduler(): void {
  if (timer) return;
  const tick = () => {
    syncDueBankFeeds().catch((error) => console.warn("[tohyee] Bank feed scheduler:", error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}
