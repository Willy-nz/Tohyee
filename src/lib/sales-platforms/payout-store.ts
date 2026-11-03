import type { OrgTx } from "@/lib/db/org-transaction";
import { dec, toFixedString } from "@/lib/money/decimal";
import type { PlatformPayout } from "@/lib/sales-platforms/connector";
import { localDate } from "@/lib/sales-platforms/orders";
import { summariseSettlement } from "@/lib/sales-platforms/payout-match";
import type { SalesPlatform } from "@/lib/sales-platforms/types";

/**
 * Payouts as the store described them (#548, SPR1), kept at each sync in
 * the sync's write transaction (no network), for the bank reconcile
 * screen's payout guide. Its own file so the sync service doesn't import
 * the reconciliation code that reads connections through it.
 */

const money = (value: string) => toFixedString(dec(value), 2);

/**
 * Remembers a payout as the store described it (SPR1). Its settlement is
 * kept when its balance transactions were read; a later read without them
 * (a payout already posted isn't read again) keeps what's there. The same
 * payout read twice is one row.
 */
export async function savePayout(tx: OrgTx, connection: { id: string; platform: SalesPlatform; storeDomain: string }, payout: PlatformPayout): Promise<void> {
  const detail = payout.transactions.length > 0 ? summariseSettlement(payout.transactions, payout.net, payout.direction) : null;
  await tx.query(
    `insert into sales_platform_payouts (platform, store_domain, external_id, connection_id, issued_on, status, direction, currency_code, net,
                                         detail_read, gross_sales, refunds, fees, adjustments, chargebacks, reserves, other_amounts,
                                         transaction_count, incomplete, order_names, recheck)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, false)
     on conflict (platform, store_domain, external_id) do update
        set connection_id = excluded.connection_id, recheck = false, issued_on = excluded.issued_on, status = excluded.status,
            direction = excluded.direction, currency_code = excluded.currency_code, net = excluded.net, last_seen_at = now(),
            detail_read = sales_platform_payouts.detail_read or excluded.detail_read,
            gross_sales = coalesce(excluded.gross_sales, sales_platform_payouts.gross_sales),
            refunds = coalesce(excluded.refunds, sales_platform_payouts.refunds),
            fees = coalesce(excluded.fees, sales_platform_payouts.fees),
            adjustments = coalesce(excluded.adjustments, sales_platform_payouts.adjustments),
            chargebacks = coalesce(excluded.chargebacks, sales_platform_payouts.chargebacks),
            reserves = coalesce(excluded.reserves, sales_platform_payouts.reserves),
            other_amounts = coalesce(excluded.other_amounts, sales_platform_payouts.other_amounts),
            transaction_count = coalesce(excluded.transaction_count, sales_platform_payouts.transaction_count),
            incomplete = case when excluded.detail_read then excluded.incomplete else sales_platform_payouts.incomplete end,
            order_names = case when excluded.detail_read then excluded.order_names else sales_platform_payouts.order_names end`,
    [
      connection.platform,
      connection.storeDomain,
      payout.externalId,
      connection.id,
      localDate(payout.issuedAt),
      payout.status.slice(0, 30),
      payout.direction.slice(0, 30),
      payout.currency,
      money(payout.net),
      detail !== null,
      detail?.grossSales ?? null,
      detail?.refunds ?? null,
      detail?.fees ?? null,
      detail?.adjustments ?? null,
      detail?.chargebacks ?? null,
      detail?.reserves ?? null,
      detail?.other ?? null,
      detail?.transactionCount ?? null,
      payout.incomplete,
      detail?.orderNames ?? [],
    ],
  );
}


/**
 * Where the next sync starts reading payouts when some are to be looked at
 * again (SPC39): the start of the earliest such payout's day, or null when
 * none are. Payouts posted already are skipped by their document, so
 * reading them again never posts one twice.
 */
export async function payoutsRecheckFrom(tx: OrgTx, connectionId: string): Promise<string | null> {
  const found = await tx.query<{ issued_on: string | null }>(
    "select min(issued_on)::text as issued_on from sales_platform_payouts where connection_id = $1 and recheck",
    [connectionId],
  );
  return found.rows[0]?.issued_on ?? null;
}

/**
 * "Try again" (SPC39): every paid payout of the store that isn't in the
 * accounts is read again at the next sync. Returns how many. Nothing is
 * posted here.
 */
export async function markPayoutsForRecheck(tx: OrgTx, connectionId: string): Promise<number> {
  await tx.query(
    `update sales_platform_payouts p set recheck = true
      where p.connection_id = $1 and p.status = 'PAID' and not p.recheck
        and not exists (select 1 from sales_platform_documents d
                         where d.platform = p.platform and d.store_domain = p.store_domain and d.record_kind = 'payout' and d.external_id = p.external_id)`,
    [connectionId],
  );
  const waiting = await tx.query<{ n: string }>("select count(*)::text as n from sales_platform_payouts where connection_id = $1 and recheck", [connectionId]);
  return Number(waiting.rows[0].n);
}
