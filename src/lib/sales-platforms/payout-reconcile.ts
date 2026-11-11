/**
 * Guided reconciliation of platform payout deposits (#548, examples
 * SPR1-SPR10, decisions 1300-1307). Keeps each payout's settlement as the
 * store described it (at sync, inside the sync's write transaction: no
 * network here), and works out what an unreconciled bank line is. Only
 * reads, apart from `savePayout`: matching itself is the bank reconcile
 * screen's ordinary "match" or "transfer", done by a person.
 *
 * Sales and fees are recognised once: orders post the sales into the
 * clearing account, the payout posting takes the fees out and transfers the
 * net to the bank (SPC15). Matching a deposit only ties the bank line to
 * that transfer. GST: payouts, fees and transfers carry none (SPC15); GST on
 * sales comes only from the orders, which follow the registration (#546).
 */
import { getStatementLine } from "@/lib/bank/accounts";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { add, dec, toFixedString } from "@/lib/money/decimal";
import { redactSecrets } from "@/lib/sales-platforms/diagnostics";
import {
  guidePayoutLine,
  PAYOUT_DAYS_AFTER,
  PAYOUT_DAYS_BEFORE,
  type PayoutCandidate,
  type PayoutConnection,
  signedNet,
  type PayoutGuidance,
  type Settlement,
} from "@/lib/sales-platforms/payout-match";
import { settlementGuidanceForLine } from "@/lib/sales-platforms/gateway-settlements";
import { listConnections } from "@/lib/sales-platforms/service";
import { PAYOUT_SCOPES, SALES_PLATFORM_LABELS, type SalesPlatform } from "@/lib/sales-platforms/types";
import { getGstRegistration, gstStatusOn, type GstStatus } from "@/lib/tax/registration";
import { optionalId } from "@/lib/validation";

const money = (value: string) => toFixedString(dec(value), 2);

type PayoutRow = {
  connection_id: string;
  platform: SalesPlatform;
  store_domain: string;
  external_id: string;
  issued_on: string;
  status: string;
  direction: string;
  currency_code: string;
  net: string;
  detail_read: boolean;
  gross_sales: string | null;
  refunds: string | null;
  fees: string | null;
  adjustments: string | null;
  chargebacks: string | null;
  reserves: string | null;
  other_amounts: string | null;
  transaction_count: number | null;
  order_names: string[];
  journal_line_id: string | null;
  journal_id: string | null;
  reconciled_line_id: string | null;
  reconciled_line_date: string | null;
  refusal: string | null;
  orders_not_in_books: string[];
  /** False when the payout is known only from its posted transfer (posted before settlements were kept). */
  from_payout_row: boolean;
};

/**
 * Payouts of these stores issued between the dates, with what they became:
 * the posted transfer's line on its bank account (the account payouts
 * arrive in) and the statement line it's reconciled with. Payouts posted
 * before #548 have no row of their own; they come from their posted
 * transfer, with no settlement.
 */
async function loadPayouts(tx: OrgTx, connectionIds: string[], from: string, to: string): Promise<PayoutRow[]> {
  if (connectionIds.length === 0) return [];
  const result = await tx.query<PayoutRow>(
    // One row per store, however many connections it has had (#570): a store connected again as a new connection
    // would otherwise list each of its payouts once per connection. Its payouts are shown under its live connection.
    `with stores as (
       select distinct on (c.platform, c.store_domain) c.id, c.platform, c.store_domain
         from sales_platform_connections c where c.id = any($1::bigint[])
        order by c.platform, c.store_domain, (c.status = 'disconnected'), c.id desc
     ),
     known as (
       select s.id::text as connection_id, p.platform, p.store_domain, p.external_id, p.issued_on::text, p.status, p.direction, p.currency_code,
              p.net::text, p.detail_read, p.gross_sales::text, p.refunds::text, p.fees::text, p.adjustments::text, p.chargebacks::text,
              p.reserves::text, p.other_amounts::text, p.transaction_count, p.order_names, true as from_payout_row
         from sales_platform_payouts p join stores s on s.platform = p.platform and s.store_domain = p.store_domain
        where p.issued_on between $2::date and $3::date
       union all
       select s.id::text, d.platform, d.store_domain, d.external_id, t.transfer_date::text, 'PAID', 'DEPOSIT', t.currency_code,
              t.amount::text, false, null, null, null, null, null, null, null, null, '{}'::text[], false
         from sales_platform_documents d join stores s on s.platform = d.platform and s.store_domain = d.store_domain
         join bank_transfers t on t.id = d.transfer_id
        where d.record_kind = 'payout' and t.status = 'posted' and t.transfer_date between $2::date and $3::date
          and not exists (select 1 from sales_platform_payouts p where p.platform = d.platform and p.store_domain = d.store_domain and p.external_id = d.external_id)
     )
     select k.*, l.id::text as journal_line_id, l.journal_id::text as journal_id,
            rl.id::text as reconciled_line_id, rl.line_date::text as reconciled_line_date,
            (select g.message from sales_platform_sync_log g
              where g.connection_id in (select c.id from sales_platform_connections c where c.platform = k.platform and c.store_domain = k.store_domain)
                and g.record_kind = 'payout' and g.external_id = k.external_id
              order by g.id desc limit 1) as refusal,
            coalesce((select array_agg(n.name order by n.name) from unnest(k.order_names) as n(name)
                       where not exists (select 1 from sales_platform_documents o
                                          where o.platform = k.platform and o.store_domain = k.store_domain and o.record_kind = 'order'
                                            and o.name = n.name and o.state = 'done')), '{}'::text[]) as orders_not_in_books
       from known k
       left join sales_platform_documents d on d.platform = k.platform and d.store_domain = k.store_domain and d.record_kind = 'payout' and d.external_id = k.external_id
       left join bank_transfers t on t.id = d.transfer_id and t.status = 'posted'
       -- The bank side of the payout's transfer: where it went, or for a withdrawal (SPC40) where it came from.
       left join ledger_journal_lines l on l.journal_id = t.journal_id
             and l.account_id = case when k.direction = 'WITHDRAWAL' then t.from_account_id else t.to_account_id end
       left join bank_reconciliation_items i on i.journal_line_id = l.id and i.active
       left join bank_reconciliations r on r.id = i.reconciliation_id
       left join bank_statement_lines rl on rl.id = r.statement_line_id
      order by k.issued_on, k.external_id`,
    [connectionIds, from, to],
  );
  return result.rows;
}

function settlementOf(row: PayoutRow): Settlement | null {
  if (!row.detail_read) return null;
  const parts = [row.gross_sales!, row.refunds!, row.fees!, row.adjustments!, row.chargebacks!, row.reserves!, row.other_amounts!].map(money);
  const total = parts.reduce(addMoney, "0.00");
  return {
    grossSales: parts[0],
    refunds: parts[1],
    fees: parts[2],
    adjustments: parts[3],
    chargebacks: parts[4],
    reserves: parts[5],
    other: parts[6],
    net: toFixedString(signedNet(row.net, row.direction), 2),
    transactionCount: row.transaction_count ?? 0,
    addsUp: total === money(toFixedString(signedNet(row.net, row.direction), 2)),
    orderNames: row.order_names,
  };
}

/**
 * Why a payout has no settlement (#578), decided from what's known: it
 * isn't paid yet; it was posted before Tohyee kept settlements (known only
 * from its posted transfer); or it hasn't been read with its transactions.
 */
function missingSettlement(row: PayoutRow): { status: "not_paid_yet" | "posted_without_settlement" | "not_read"; note: string } {
  if (row.status !== "PAID") {
    return { status: "not_paid_yet", note: `The store hasn't paid this payout yet (${row.status.toLowerCase().replace(/_/g, " ")}); its settlement is read once it's paid.` };
  }
  if (!row.from_payout_row) {
    return { status: "posted_without_settlement", note: "This payout was posted before Tohyee kept settlements, so only its net is known." };
  }
  return { status: "not_read", note: "Its transactions haven't been read from the store yet; they are at the next sync." };
}

function addMoney(a: string, b: string): string {
  return toFixedString(add(dec(a), dec(b)), 2);
}

/** Only the log line's words when it says why the payout wasn't posted. */
function refusalOf(row: PayoutRow): string | null {
  if (row.journal_line_id || !row.refusal) return null;
  return redactSecrets(row.refusal);
}

function candidateOf(row: PayoutRow): PayoutCandidate {
  return {
    connectionId: row.connection_id,
    platformLabel: SALES_PLATFORM_LABELS[row.platform] ?? row.platform,
    externalId: row.external_id,
    issuedOn: row.issued_on,
    status: row.status,
    direction: row.direction,
    net: money(row.net),
    currency: row.currency_code,
    settlement: settlementOf(row),
    posted: row.journal_line_id
      ? { journalLineId: row.journal_line_id, journalId: row.journal_id!, reconciledLineId: row.reconciled_line_id, reconciledLineDate: row.reconciled_line_date }
      : null,
    refusal: refusalOf(row),
    ordersNotInBooks: row.orders_not_in_books,
  };
}

/** The connections whose platform pays out (Shopify), with what posting still needs. */
async function payoutConnections(tx: OrgTx, connectionId: string | null = null): Promise<PayoutConnection[]> {
  const shopify = (await listConnections(tx)).filter((connection) => connection.platform === "shopify");
  // #570: a store connected again is a new connection; the old, disconnected one is left out while the store has a live one.
  const live = new Set(shopify.filter((connection) => connection.status !== "disconnected").map((connection) => connection.storeDomain.toLowerCase()));
  const all = shopify.filter(
    (connection) =>
      (connectionId === null || connection.id === connectionId) &&
      (connection.status !== "disconnected" || connection.id === connectionId || !live.has(connection.storeDomain.toLowerCase())),
  );
  const ids = await tx.query<{ id: string; payout_account_id: string | null; clearing_name: string | null }>(
    `select c.id::text, c.payout_account_id::text, a.name as clearing_name
       from sales_platform_connections c left join accounts a on a.id = c.clearing_account_id where c.id = any($1::bigint[])`,
    [all.map((connection) => connection.id)],
  );
  const byId = new Map(ids.rows.map((row) => [row.id, row]));
  return all.map((connection) => {
    const label = SALES_PLATFORM_LABELS[connection.platform];
    const missing: string[] = [];
    if (!connection.clearingAccountCode) missing.push("clearing account");
    if (!connection.payoutAccountCode) missing.push("account payouts arrive in");
    if (!connection.feesAccountCode) missing.push("fees account");
    if (!connection.startDate) missing.push("start date");
    return {
      connectionId: connection.id,
      platformLabel: label,
      names: [label.toLowerCase()],
      postingOn: connection.postToAccounts && connection.status !== "disconnected",
      payoutAccountId: byId.get(connection.id)?.payout_account_id ?? null,
      payoutAccountCode: connection.payoutAccountCode,
      clearingAccountCode: connection.clearingAccountCode,
      clearingAccountName: byId.get(connection.id)?.clearing_name ?? null,
      startDate: connection.startDate,
      missing,
      readsPayouts: PAYOUT_SCOPES.every((scope) => connection.grantedScopes.includes(scope)),
    };
  });
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const lineText = (line: { description: string; payee: string | null; particulars: string | null; code: string | null; reference: string | null }) =>
  [line.payee, line.description, line.particulars, line.code, line.reference].filter(Boolean).join(" ");

/** What the GST registration means for a payout on this date (SPR10): payouts never carry GST; only the orders do. */
function gstNote(status: GstStatus): string {
  return status === "registered"
    ? "Registered: GST on the sales came from the orders. Payouts, fees and transfers have no GST."
    : status === "unconfirmed"
      ? "GST registration isn't confirmed: orders wait and nothing here posts GST."
      : "Not registered on this date: no GST anywhere in this payout, whatever the store's tax fields say.";
}

export type LinePayoutGuidance = (PayoutGuidance & { gst: { status: GstStatus; note: string } }) | null;

/**
 * What an unreconciled statement line is, as far as platform payouts go
 * (SPR2-SPR10), or null when it has nothing to do with them. Read-only.
 */
export async function payoutGuidanceForLine(tx: OrgTx, lineIdInput: unknown): Promise<LinePayoutGuidance> {
  const line = await getStatementLine(tx, lineIdInput);
  if (line.status !== "unreconciled") return null;
  const connections = await payoutConnections(tx);
  if (connections.length === 0) return null;
  const payouts = await loadPayouts(
    tx,
    connections.map((connection) => connection.connectionId),
    shiftDays(line.date, -PAYOUT_DAYS_BEFORE),
    shiftDays(line.date, PAYOUT_DAYS_AFTER),
  );
  const guidance = guidePayoutLine(
    { id: line.id, accountId: line.accountId, date: line.date, amount: line.amount, text: lineText(line) },
    connections,
    payouts.map(candidateOf),
  );
  if (!guidance) return null;
  const status = gstStatusOn(await getGstRegistration(tx), line.date);
  return { ...guidance, gst: { status, note: gstNote(status) } };
}

const LINE_LIMIT = 50;

/**
 * Payouts and deposits for MCP (SPR10): each payout issued between the
 * dates with its settlement, whether it's posted and which bank line it's
 * matched to, and every unreconciled deposit on a payout account in the
 * same dates with its guidance. Read-only: it suggests, a person reconciles.
 */
export async function payoutMatchReport(tx: OrgTx, options: { connectionId?: unknown; from?: unknown; to?: unknown } = {}, today: string = new Date().toISOString().slice(0, 10)) {
  const connectionId = optionalId(options.connectionId, "connectionId");
  const date = (value: unknown, field: string, fallback: string) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${field} must be a date (YYYY-MM-DD).`);
    return value;
  };
  const to = date(options.to, "to", today);
  const from = date(options.from, "from", shiftDays(to, -30));
  if (from > to) throw new ValidationError("from must be on or before to.");
  const connections = await payoutConnections(tx, connectionId);
  if (connectionId && connections.length === 0) throw new ValidationError("That connection wasn't found, or its platform has no payouts.");
  const registration = await getGstRegistration(tx);
  const ids = connections.map((connection) => connection.connectionId);
  const rows = await loadPayouts(tx, ids, from, to);
  const payouts = rows.map((row) => {
    const candidate = candidateOf(row);
    const gst = gstStatusOn(registration, candidate.issuedOn);
    return {
      connectionId: candidate.connectionId,
      payoutId: candidate.externalId,
      issuedOn: candidate.issuedOn,
      status: candidate.status,
      direction: candidate.direction,
      net: candidate.net,
      currency: candidate.currency,
      settlement: candidate.settlement ?? missingSettlement(row),
      inAccounts: candidate.posted !== null,
      ...(candidate.refusal ? { whyNotInAccounts: candidate.refusal } : {}),
      bankLine: candidate.posted?.reconciledLineId ? { lineId: candidate.posted.reconciledLineId, date: candidate.posted.reconciledLineDate } : null,
      ...(candidate.ordersNotInBooks.length > 0
        ? { ordersNotInBooks: candidate.ordersNotInBooks, ordersNote: "These orders' charges are in the payout but the orders aren't in the books, so the clearing account won't clear." }
        : {}),
      gst: { status: gst, note: gstNote(gst) },
    };
  });
  const accounts = connections.map((connection) => connection.payoutAccountId).filter((id): id is string => id !== null);
  const lines = await tx.query<{ id: string }>(
    `select b.id::text from bank_statement_lines b
      where b.account_id = any($1::bigint[]) and b.status = 'unreconciled' and b.amount <> 0 and b.line_date between $2::date and $3::date
      order by b.line_date, b.id limit ${LINE_LIMIT + 1}`,
    [accounts, from, to],
  );
  const deposits = [];
  for (const row of lines.rows.slice(0, LINE_LIMIT)) {
    const line = await getStatementLine(tx, row.id);
    const guidance = await payoutGuidanceForLine(tx, row.id);
    // Money out is listed only when it's a withdrawal payout (SPC40), not every bill paid from the account.
    if (!guidance && line.amount.startsWith("-")) continue;
    // GS5: a payment gateway's own deposit (Afterpay, say), settling orders in its clearing account.
    const gateway = guidance ? null : await settlementGuidanceForLine(tx, row.id);
    deposits.push({
      lineId: line.id,
      date: line.date,
      amount: line.amount,
      text: lineText(line),
      ...(guidance
        ? {
            status: guidance.status,
            reason: guidance.reason,
            evidence: guidance.evidence,
            payoutIds: guidance.payouts.map((payout) => payout.externalId),
            suggestion: guidance.action
              ? { ...guidance.action, note: "A suggestion for a person to review on the bank reconcile screen; this tool doesn't reconcile." }
              : null,
          }
        : gateway
          ? {
              status: "gateway_settlement",
              reason: gateway.reason,
              gateway: gateway.gateway,
              match: gateway.status,
              choices: gateway.choices,
              feesAccountCode: gateway.feesAccountCode,
              suggestion: gateway.choices.length > 0 ? "Settle it on the bank reconcile screen: a transfer from the clearing account, with the fee. This tool doesn't reconcile." : null,
            }
          : { status: "not_a_payout", reason: "Nothing on the line or its account points to a platform payout." }),
    });
  }
  // Each clearing account once, however many connections share it (#570), so its balance is the ledger's.
  const clearing = await tx.query<{ code: string; balance: string }>(
    `select a.code, to_char(coalesce(sum(l.debit_amount - l.credit_amount), 0), 'FM999999999990.00') as balance
       from accounts a
       left join ledger_journal_lines l on l.account_id = a.id
       left join ledger_journals j on j.id = l.journal_id and j.posting_date <= $2::date
      where a.id in (select c.clearing_account_id from sales_platform_connections c where c.id = any($1::bigint[]))
        and (l.id is null or j.id is not null)
      group by a.code order by a.code`,
    [ids, to],
  );
  return {
    from,
    to,
    payouts,
    deposits,
    ...(lines.rows.length > LINE_LIMIT ? { moreDeposits: `Only the first ${LINE_LIMIT} deposits are listed; ask for a shorter date range.` } : {}),
    clearingBalances: clearing.rows.map((row) => ({
      accountCode: row.code,
      balance: row.balance,
      note: "What the books say the platform still holds on the to date: sales not yet paid out, less fees not yet recorded.",
    })),
    statuses: {
      matched: "The payout is posted and this deposit is it (by its ID, or its platform name, amount and date).",
      combined: "Several posted payouts together make this deposit.",
      needs_choice: "More than one payout fits, or only the amount and date do: a person chooses.",
      already_matched: "The payout is already matched to another bank line: this may be a duplicate import.",
      payout_not_posted: "The payout is known but not in the accounts yet (not paid, or refused: see the reason).",
      missing_posting_setup: "The store isn't set up to post payouts into this account.",
      missing_settlement_data: "Tohyee has no settlement for this deposit (before the start date, or payouts can't be read).",
      unmatched: "Nothing fits; left for a person.",
      gateway_settlement: "A payment gateway's deposit (Afterpay, say): the order payments in its clearing account it settles, less its fee.",
    },
  };
}
