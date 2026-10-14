/*
 * Year-end financial statements built from the ledger (#259):
 * - statement of changes in equity (examples SCE1, SCE2);
 * - statement of cash flows, indirect method (examples SCF1-SCF4).
 * Both cover a period (default: the financial year to date) and post
 * nothing.
 */
import type { AccountType } from "@/lib/accounts/types";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { addDays, financialYearStart } from "@/lib/financial-year";
import { add, cmp, dec, type Decimal, isZero, neg, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { accountTotals, balanceSheet, earningsOf, financialYearEndMonth, moneyFormatter } from "@/lib/reports/financial";

type Period = { from: string; to: string };

async function period(tx: OrgTx, input: { from?: unknown; to?: unknown }): Promise<Period> {
  const to = parseOptionalIsoDate(input.to, "to") ?? todayIsoDate();
  const from = input.from == null || input.from === "" ? financialYearStart(to, await financialYearEndMonth(tx)) : parseIsoDate(input.from, "from");
  if (from > to) throw new ValidationError("'from' must be on or before 'to'.");
  return { from, to };
}

export type StatementRow = { accountId: string | null; code: string | null; label: string; amount: string };

/**
 * Statement of changes in equity, one column (SCE1): equity at the start,
 * the period's profit, each equity account's movement by its name, and
 * equity at the end. Opening and closing equity are the balance sheet's
 * total equity the day before `from` and on `to`.
 */
export async function changesInEquity(tx: OrgTx, input: { from?: unknown; to?: unknown }) {
  const { from, to } = await period(tx, input);
  const money = moneyFormatter(tx);
  const opening = dec((await balanceSheet(tx, { asAt: addDays(from, -1) })).equity.total);
  const closing = dec((await balanceSheet(tx, { asAt: to })).equity.total);
  const rows = await accountTotals(tx, from, to);
  const profit = earningsOf(rows);
  const movements = rows
    .filter((row) => row.account_type === "equity")
    .map((row) => ({ row, amount: sub(dec(row.credits), dec(row.debits)) }))
    .filter(({ amount }) => !isZero(amount));
  let worked = add(opening, profit);
  for (const { amount } of movements) worked = add(worked, amount);
  return {
    from,
    to,
    currencyCode: tx.baseCurrency,
    openingEquity: money(opening),
    profit: money(profit),
    movements: movements.map(({ row, amount }): StatementRow => ({ accountId: row.id, code: row.code, label: row.name, amount: money(amount) })),
    closingEquity: money(closing),
    /** Opening + profit + movements = the balance sheet's closing equity. */
    reconciles: cmp(worked, closing) === 0,
  };
}

const WORKING_CAPITAL: readonly AccountType[] = ["current_asset", "inventory", "credit_card", "current_liability"];
const INVESTING: readonly AccountType[] = ["fixed_asset", "non_current_asset"];
const FINANCING: readonly AccountType[] = ["non_current_liability", "equity"];
const PROFIT_OR_LOSS_CLASSES = new Set(["revenue", "expense"]);

/** How a journal's lines are treated (SCF2-SCF4). */
type Bucket = "normal" | "depreciation" | "livestock" | "fx" | "disposal" | "opening";
const NON_CASH_LABELS: Record<Exclude<Bucket, "normal">, string> = {
  depreciation: "Depreciation",
  livestock: "Change in livestock value",
  fx: "Unrealised exchange gains and losses",
  disposal: "Gain or loss on disposal of fixed assets",
  opening: "Profit in opening balances",
};

type LineGroup = { account_id: string; code: string; name: string; account_class: string; account_type: AccountType; bucket: Bucket; net_debit: string };

/**
 * Statement of cash flows, indirect method (SCF1). Cash is the bank
 * accounts. Starting from the period's profit:
 * - operating: non-cash items added back (depreciation, livestock
 *   revaluation, unrealised exchange, disposal gains), then movements in
 *   current assets and liabilities (receivables, stock, GST, credit cards,
 *   payables), each by account;
 * - investing: movements in fixed and non-current assets, with disposal
 *   proceeds on their own line;
 * - financing: movements in non-current liabilities and equity.
 * Interest stays in operating. Unrealised exchange on bank accounts is the
 * "effect of exchange rates on cash"; opening-balance journals count as
 * cash at the start.
 */
export async function cashFlowStatement(tx: OrgTx, input: { from?: unknown; to?: unknown }) {
  const { from, to } = await period(tx, input);
  const money = moneyFormatter(tx);
  const groups = (
    await tx.query<LineGroup>(
      `with journals as (
         select j.id,
                case
                  when j.origin = 'opening_balance' then 'opening'
                  when j.origin = 'fixed_asset_disposal' then 'disposal'
                  when j.origin = 'fixed_asset_depreciation' then 'depreciation'
                  when j.origin = 'livestock_valuation' then 'livestock'
                  when j.origin = 'fx_revaluation' then 'fx'
                  -- A depreciation journal entered by hand: depreciation and no bank.
                  when exists (select 1 from ledger_journal_lines l join accounts a on a.id = l.account_id
                                where l.journal_id = j.id and a.account_type = 'depreciation')
                   and not exists (select 1 from ledger_journal_lines l join accounts a on a.id = l.account_id
                                    where l.journal_id = j.id and a.account_type = 'bank') then 'depreciation'
                  else 'normal'
                end as bucket
           from ledger_journals j
          where j.posting_date between $1 and $2
       )
       select a.id::text as account_id, a.code, a.name, a.account_class, a.account_type, jr.bucket,
              sum(l.debit_amount - l.credit_amount)::text as net_debit
         from journals jr
         join ledger_journal_lines l on l.journal_id = jr.id
         join accounts a on a.id = l.account_id
        group by a.id, jr.bucket
        order by a.code`,
      [from, to],
    )
  ).rows;

  // Cash effect of lines: money in is a credit to the other side.
  const cash = (group: LineGroup) => neg(dec(group.net_debit));
  let profit = ZERO_DECIMAL;
  const nonCash = new Map<Bucket, Decimal>();
  const byAccount = (target: Map<string, { group: LineGroup; amount: Decimal }>, group: LineGroup, amount: Decimal) => {
    const existing = target.get(group.account_id);
    target.set(group.account_id, { group, amount: add(existing?.amount ?? ZERO_DECIMAL, amount) });
  };
  const workingCapital = new Map<string, { group: LineGroup; amount: Decimal }>();
  const investing = new Map<string, { group: LineGroup; amount: Decimal }>();
  const financing = new Map<string, { group: LineGroup; amount: Decimal }>();
  let disposalProceeds = ZERO_DECIMAL;
  let exchangeOnCash = ZERO_DECIMAL;
  let openingBalanceCash = ZERO_DECIMAL;

  for (const group of groups) {
    const amount = cash(group);
    const isBank = group.account_type === "bank";
    if (PROFIT_OR_LOSS_CLASSES.has(group.account_class)) {
      profit = add(profit, amount);
      if (group.bucket !== "normal") {
        // Taken back out of operating; a disposal's gain moves to investing.
        nonCash.set(group.bucket, sub(nonCash.get(group.bucket) ?? ZERO_DECIMAL, amount));
        if (group.bucket === "disposal") disposalProceeds = add(disposalProceeds, amount);
      }
      continue;
    }
    if (isBank) {
      if (group.bucket === "opening") openingBalanceCash = add(openingBalanceCash, dec(group.net_debit));
      else if (group.bucket === "fx" || group.bucket === "depreciation" || group.bucket === "livestock") exchangeOnCash = add(exchangeOnCash, dec(group.net_debit));
      continue;
    }
    if (group.bucket === "opening" || group.bucket === "fx" || group.bucket === "depreciation" || group.bucket === "livestock") continue;
    if (group.bucket === "disposal" && INVESTING.includes(group.account_type)) {
      disposalProceeds = add(disposalProceeds, amount);
      continue;
    }
    if (WORKING_CAPITAL.includes(group.account_type)) byAccount(workingCapital, group, amount);
    else if (INVESTING.includes(group.account_type)) byAccount(investing, group, amount);
    else if (FINANCING.includes(group.account_type)) byAccount(financing, group, amount);
  }

  const rows = (map: Map<string, { group: LineGroup; amount: Decimal }>) =>
    [...map.values()].filter(({ amount }) => !isZero(amount)).map(({ group, amount }) => ({ group, amount }));
  const total = (items: Array<{ amount: Decimal }>) => items.reduce((sum, item) => add(sum, item.amount), ZERO_DECIMAL);
  const show = (items: Array<{ group: LineGroup; amount: Decimal }>): StatementRow[] =>
    items.map(({ group, amount }) => ({ accountId: group.account_id, code: group.code, label: group.name, amount: money(amount) }));

  const adjustments = (["depreciation", "livestock", "fx", "disposal", "opening"] as const)
    .map((bucket) => ({ bucket, amount: nonCash.get(bucket) ?? ZERO_DECIMAL }))
    .filter(({ amount }) => !isZero(amount));
  const wc = rows(workingCapital);
  const operating = add(add(profit, total(adjustments)), total(wc));
  const inv = rows(investing);
  const investingTotal = add(total(inv), disposalProceeds);
  const fin = rows(financing);
  const financingTotal = total(fin);
  const netChange = add(add(operating, investingTotal), financingTotal);

  const bankBefore = await bankBalance(tx, addDays(from, -1));
  const openingCash = add(bankBefore, openingBalanceCash);
  const closingCash = await bankBalance(tx, to);
  return {
    from,
    to,
    currencyCode: tx.baseCurrency,
    operating: {
      profit: money(profit),
      adjustments: adjustments.map(({ bucket, amount }): StatementRow => ({ accountId: null, code: null, label: NON_CASH_LABELS[bucket], amount: money(amount) })),
      workingCapital: show(wc),
      total: money(operating),
    },
    investing: {
      lines: show(inv),
      disposalProceeds: money(disposalProceeds),
      total: money(investingTotal),
    },
    financing: { lines: show(fin), total: money(financingTotal) },
    netChange: money(netChange),
    exchangeOnCash: money(exchangeOnCash),
    openingCash: money(openingCash),
    closingCash: money(closingCash),
    /** Opening cash + net change + exchange = the bank accounts' closing balance. */
    reconciles: cmp(add(add(openingCash, netChange), exchangeOnCash), closingCash) === 0,
  };
}

async function bankBalance(tx: OrgTx, asAt: string): Promise<Decimal> {
  const result = await tx.query<{ balance: string }>(
    `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as balance
       from ledger_journal_lines l
       join ledger_journals j on j.id = l.journal_id
       join accounts a on a.id = l.account_id
      where a.account_type = 'bank' and j.posting_date <= $1`,
    [asAt],
  );
  return dec(result.rows[0].balance);
}
