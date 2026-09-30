import { parseAccountCodeInput, resolveAccountsByCode } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { foreignAccountState } from "@/lib/ledger/foreign";
import { type ForeignAmount, type JournalBody, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { currencyMinorUnits, parseCurrencyCode } from "@/lib/money/currency";
import {
  abs,
  dec,
  isNegative,
  isZero,
  mul,
  parseDecimalInput,
  roundHalfUp,
  sub,
  toFixedString,
  toPlainString,
} from "@/lib/money/decimal";
import {
  asRecord,
  optionalSource,
  optionalString,
  requireArray,
  requireIdempotencyKey,
  requireString,
} from "@/lib/validation";

export type FxRevaluationItem = {
  lineOrder: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  balanceType: "asset" | "liability";
  currencyCode: string;
  foreignAmount: string;
  carryingAmount: string;
  revaluedAmount: string;
  closingRate: string;
  deltaAmount: string;
  description: string | null;
};

export type FxRevaluationRun = {
  id: string;
  reference: string;
  description: string | null;
  baseCurrency: string;
  revaluationDate: string;
  reversalPostingDate: string;
  rateDate: string;
  rateSource: string;
  operatorEmail: string;
  gainAccountCode: string;
  lossAccountCode: string;
  revaluationJournalId: string;
  reversalJournalId: string;
  createdAt: string;
  items: FxRevaluationItem[];
};

type RunRow = {
  id: string;
  request_hash: string;
  reference: string;
  description: string | null;
  base_currency: string;
  revaluation_date: string;
  reversal_posting_date: string;
  rate_date: string;
  rate_source: string;
  operator_email: string;
  gain_code: string;
  loss_code: string;
  revaluation_journal_id: string;
  reversal_journal_id: string;
  created_at: string;
};

const RUN_SELECT = `
  select r.id, r.request_hash, r.reference, r.description, r.base_currency, r.revaluation_date,
         r.reversal_posting_date, r.rate_date, r.rate_source, r.operator_email,
         g.code as gain_code, l.code as loss_code,
         r.revaluation_journal_id, r.reversal_journal_id, r.created_at
    from ledger_fx_revaluation_runs r
    join accounts g on g.id = r.unrealised_gain_account_id
    join accounts l on l.id = r.unrealised_loss_account_id`;

async function loadRuns(tx: OrgTx, where: string, values: unknown[], limit = 50): Promise<FxRevaluationRun[]> {
  const runs = await tx.query<RunRow>(`${RUN_SELECT} ${where} order by r.id desc limit ${limit}`, values);
  if (runs.rows.length === 0) {
    return [];
  }
  const items = await tx.query<{
    run_id: string;
    line_order: number;
    account_id: string;
    code: string;
    name: string;
    balance_type: "asset" | "liability";
    currency_code: string;
    foreign_amount: string;
    carrying_amount: string;
    revalued_amount: string;
    closing_rate: string;
    delta_amount: string;
    description: string | null;
  }>(
    `select i.run_id, i.line_order, i.account_id, a.code, a.name, i.balance_type, i.currency_code,
            i.foreign_amount, i.carrying_amount, i.revalued_amount, i.closing_rate,
            i.delta_amount, i.description
       from ledger_fx_revaluation_run_items i
       join accounts a on a.id = i.account_id
      where i.run_id = any($1::bigint[])
      order by i.run_id, i.line_order`,
    [runs.rows.map((run) => run.id)],
  );
  return runs.rows.map((run) => ({
    id: run.id,
    reference: run.reference,
    description: run.description,
    baseCurrency: run.base_currency,
    revaluationDate: run.revaluation_date,
    reversalPostingDate: run.reversal_posting_date,
    rateDate: run.rate_date,
    rateSource: run.rate_source,
    operatorEmail: run.operator_email,
    gainAccountCode: run.gain_code,
    lossAccountCode: run.loss_code,
    revaluationJournalId: run.revaluation_journal_id,
    reversalJournalId: run.reversal_journal_id,
    createdAt: run.created_at,
    items: items.rows
      .filter((item) => item.run_id === run.id)
      .map((item) => ({
        lineOrder: item.line_order,
        accountId: item.account_id,
        accountCode: item.code,
        accountName: item.name,
        balanceType: item.balance_type,
        currencyCode: item.currency_code,
        foreignAmount: item.foreign_amount,
        carryingAmount: item.carrying_amount,
        revaluedAmount: item.revalued_amount,
        closingRate: item.closing_rate,
        deltaAmount: item.delta_amount,
        description: item.description,
      })),
  }));
}

/**
 * The foreign balance to revalue, in the account's normal direction: the
 * ledger's (FXB7) when it's known, and then a typed one must agree; otherwise
 * the typed one (F1-F7 for accounts with postings from before Tohyee kept
 * foreign amounts and no opening foreign balance).
 */
async function revaluedForeignAmount(
  tx: OrgTx,
  account: { id: string; code: string; accountClass: string; currencyCode: string | null },
  typed: string | null,
  revaluationDate: string,
): Promise<string> {
  const state = await foreignAccountState(tx, account.id, revaluationDate);
  const scale = currencyMinorUnits(account.currencyCode!);
  if (state.foreignBalance === null) {
    if (typed === null) {
      throw new ValidationError(
        `Account ${account.code} has postings from before Tohyee kept foreign amounts, so type its ${account.currencyCode} balance on ${revaluationDate} (or enter its opening foreign balance on the bank account first).`,
      );
    }
    return typed;
  }
  const signed = dec(state.foreignBalance);
  const normal = toFixedString(account.accountClass === "asset" ? signed : { units: -signed.units, scale: signed.scale }, scale);
  if (typed !== null && toFixedString(dec(typed), scale) !== normal) {
    throw new ValidationError(
      `Account ${account.code}: the ledger has ${account.currencyCode} ${normal} on ${revaluationDate}, not ${toFixedString(dec(typed), scale)}. Leave the foreign amount blank to use the ledger's.`,
    );
  }
  return normal;
}

export async function listFxRevaluations(
  tx: OrgTx,
  filters: { revaluationDateFrom?: unknown; revaluationDateTo?: unknown } = {},
): Promise<FxRevaluationRun[]> {
  const from = parseOptionalIsoDate(filters.revaluationDateFrom, "revaluationDateFrom");
  const to = parseOptionalIsoDate(filters.revaluationDateTo, "revaluationDateTo");
  return loadRuns(
    tx,
    "where ($1::date is null or r.revaluation_date >= $1) and ($2::date is null or r.revaluation_date <= $2)",
    [from, to],
  );
}

/**
 * Period-end revaluation of foreign-currency asset and liability accounts.
 *
 * For each account you give the foreign-currency balance and the closing
 * rate (units of base currency per 1 unit of foreign currency). Tohyee then:
 * - takes the carrying amount from the ledger (the account's base-currency
 *   balance as at the revaluation date),
 * - computes the revalued amount = foreign amount x rate, rounded to cents,
 * - posts the difference to the unrealised gain/loss accounts, and
 * - posts an automatic reversal on the reversal date, so unrealised
 *   movements are never double counted across periods.
 */
export async function postFxRevaluation(
  tx: OrgTx,
  input: {
    source?: unknown;
    idempotencyKey: unknown;
    reference: unknown;
    description?: unknown;
    revaluationDate: unknown;
    reversalPostingDate: unknown;
    rateDate: unknown;
    rateSource: unknown;
    unrealisedGainAccountCode: unknown;
    unrealisedLossAccountCode: unknown;
    balances: unknown;
  },
): Promise<{ created: boolean; run: FxRevaluationRun }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const reference = requireString(input.reference, "reference", { maxLength: 100 });
  const description = optionalString(input.description, "description", { maxLength: 500 });
  const revaluationDate = parseIsoDate(input.revaluationDate, "revaluationDate");
  const reversalPostingDate = parseIsoDate(input.reversalPostingDate, "reversalPostingDate");
  if (reversalPostingDate <= revaluationDate) {
    throw new ValidationError("The reversal date must be after the revaluation date.");
  }
  const rateDate = parseIsoDate(input.rateDate, "rateDate");
  const rateSource = requireString(input.rateSource, "rateSource", { maxLength: 100 });
  const gainCode = parseAccountCodeInput(input.unrealisedGainAccountCode, "unrealisedGainAccountCode");
  const lossCode = parseAccountCodeInput(input.unrealisedLossAccountCode, "unrealisedLossAccountCode");

  const rawBalances = requireArray(input.balances, "balances", 200);
  if (rawBalances.length === 0) {
    throw new ValidationError("Add at least one foreign-currency balance to revalue.");
  }
  const balances = rawBalances.map((raw, index) => {
    const label = `Balance ${index + 1}`;
    const record = asRecord(raw, label);
    const accountCode = parseAccountCodeInput(record.accountCode, `${label} account`);
    const currencyCode =
      record.currencyCode == null || record.currencyCode === ""
        ? null
        : parseCurrencyCode(record.currencyCode, `${label} currency`);
    return {
      accountCode,
      claimedCurrency: currencyCode,
      foreignAmountRaw: record.foreignAmount,
      closingRate: parseDecimalInput(record.closingRate, `${label} closing rate`, { maxScale: 8 }),
      description: optionalString(record.description, `${label} description`, { maxLength: 200 }),
    };
  });
  const seen = new Set<string>();
  for (const balance of balances) {
    const key = balance.accountCode.toLowerCase();
    if (seen.has(key)) {
      throw new ValidationError(`Account ${balance.accountCode} is listed more than once.`);
    }
    seen.add(key);
  }

  const commandSource = `fx:${source}`;
  const accounts = await resolveAccountsByCode(tx, [gainCode, lossCode, ...balances.map((b) => b.accountCode)]);
  const gain = accounts.get(gainCode)!;
  const loss = accounts.get(lossCode)!;
  for (const [label, account] of [
    ["gain", gain],
    ["loss", loss],
  ] as const) {
    if (account.accountClass !== "revenue" && account.accountClass !== "expense") {
      throw new ValidationError(`The unrealised ${label} account must be an income or expense account.`);
    }
  }

  const baseScale = currencyMinorUnits(tx.baseCurrency);
  const prepared = balances.map((balance) => {
    const account = accounts.get(balance.accountCode)!;
    if (account.accountClass !== "asset" && account.accountClass !== "liability") {
      throw new ValidationError(`Account ${account.code} isn't an asset or liability account.`);
    }
    if (!account.currencyCode) {
      throw new ValidationError(
        `Account ${account.code} (${account.name}) is a ${tx.baseCurrency} account. Set its currency in the chart of accounts before revaluing it.`,
      );
    }
    if (balance.claimedCurrency && balance.claimedCurrency !== account.currencyCode) {
      throw new ValidationError(`Account ${account.code} is in ${account.currencyCode}, not ${balance.claimedCurrency}.`);
    }
    // With a known foreign balance (FXB7) it needn't be typed; otherwise it must be.
    const typed =
      balance.foreignAmountRaw == null || balance.foreignAmountRaw === ""
        ? null
        : parseDecimalInput(balance.foreignAmountRaw, `${account.code} foreign amount`, {
            maxScale: currencyMinorUnits(account.currencyCode),
          });
    return { balance, account, typed };
  });

  const hash = requestHash("fx_revaluation", {
    reference,
    description,
    revaluationDate,
    reversalPostingDate,
    rateDate,
    rateSource,
    gain: gainCode.toLowerCase(),
    loss: lossCode.toLowerCase(),
    balances: prepared.map((item) => ({
      account: item.balance.accountCode.toLowerCase(),
      foreignAmount: item.typed,
      closingRate: item.balance.closingRate,
      description: item.balance.description,
    })),
  });

  const existing = await tx.query<{ id: string; request_hash: string }>(
    `select id, request_hash from ledger_fx_revaluation_runs
      where command_source = $1 and idempotency_key = $2`,
    [commandSource, idempotencyKey],
  );
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "FX revaluation");
    const [run] = await loadRuns(tx, "where r.id = $1", [existing.rows[0].id], 1);
    return { created: false, run };
  }

  const already = await tx.query<{ code: string }>(
    `select a.code from ledger_fx_revaluation_run_items i
       join accounts a on a.id = i.account_id
      where i.revaluation_date = $1 and i.account_id = any($2::bigint[])`,
    [revaluationDate, prepared.map((item) => item.account.id)],
  );
  if (already.rows.length > 0) {
    throw new ConflictError(
      `${already.rows.map((row) => row.code).join(", ")} already revalued on ${revaluationDate}.`,
    );
  }

  const computed = [];
  for (const item of prepared) {
    const totals = await tx.query<{ debits: string; credits: string }>(
      `select coalesce(sum(l.debit_amount), 0)::text as debits,
              coalesce(sum(l.credit_amount), 0)::text as credits
         from ledger_journal_lines l
         join ledger_journals j on j.id = l.journal_id
        where l.account_id = $1 and j.posting_date <= $2`,
      [item.account.id, revaluationDate],
    );
    const debits = dec(totals.rows[0].debits);
    const credits = dec(totals.rows[0].credits);
    const carrying = item.account.accountClass === "asset" ? sub(debits, credits) : sub(credits, debits);
    if (isNegative(carrying)) {
      throw new ValidationError(
        `Account ${item.account.code} has a ${item.account.accountClass === "asset" ? "credit" : "debit"} balance on ${revaluationDate}, which this revaluation can't handle. Post the adjustment as a manual journal.`,
      );
    }
    const foreignAmount = await revaluedForeignAmount(tx, item.account, item.typed, revaluationDate);
    const revalued = roundHalfUp(mul(dec(foreignAmount), dec(item.balance.closingRate)), baseScale);
    const delta = sub(revalued, carrying);
    computed.push({
      ...item,
      foreignAmount,
      carrying: toFixedString(carrying, baseScale),
      revalued: toFixedString(revalued, baseScale),
      delta,
    });
  }

  const lines: Array<{ accountCode: string; debitAmount: string; creditAmount: string; description: string; foreign?: ForeignAmount }> = [];
  for (const item of computed) {
    if (isZero(item.delta)) continue;
    const amount = toFixedString(abs(item.delta), baseScale);
    const label = item.balance.description ?? `${item.account.code} ${item.account.currencyCode}`;
    const increases = !isNegative(item.delta);
    // An asset worth more, or a liability worth less, is a gain.
    const isGain = item.account.accountClass === "asset" ? increases : !increases;
    const accountSide = item.account.accountClass === "asset" ? increases : !increases; // debit the account?
    lines.push({
      accountCode: item.account.code,
      debitAmount: accountSide ? amount : "0",
      creditAmount: accountSide ? "0" : amount,
      description: `FX revaluation ${label}`,
      // Only the base value changes: a foreign amount of 0 at the closing rate (FXB7).
      foreign: {
        currencyCode: item.account.currencyCode!,
        amount: toFixedString(dec("0"), currencyMinorUnits(item.account.currencyCode!)),
        rate: toPlainString(dec(item.balance.closingRate)),
        kind: "revaluation",
      },
    });
    lines.push({
      accountCode: isGain ? gain.code : loss.code,
      debitAmount: accountSide ? "0" : amount,
      creditAmount: accountSide ? amount : "0",
      description: `Unrealised FX ${isGain ? "gain" : "loss"} ${label}`,
    });
  }
  if (lines.length === 0) {
    throw new ValidationError("Nothing to revalue: every balance already matches the closing rate.");
  }

  const revaluationBody: JournalBody = parseJournalBody(
    tx,
    {
      postingDate: revaluationDate,
      reference,
      description: description ?? `FX revaluation ${reference}`,
      lines,
    },
    { internal: true },
  );
  const reversalBody: JournalBody = parseJournalBody(tx, {
    postingDate: reversalPostingDate,
    reference: `REV-${reference}`.slice(0, 100),
    description: `Automatic reversal of FX revaluation ${reference}`,
    lines: lines.map((line) => ({
      accountCode: line.accountCode,
      debitAmount: line.creditAmount,
      creditAmount: line.debitAmount,
      description: line.description,
      foreign: line.foreign,
    })),
  }, { internal: true });

  const revaluationJournal = await postJournalBody(tx, commandSource, `${idempotencyKey}:journal`, revaluationBody, {
    origin: "fx_revaluation",
  });
  const reversalJournal = await postJournalBody(tx, commandSource, `${idempotencyKey}:reversal`, reversalBody, {
    origin: "fx_revaluation",
  });

  const run = await tx.query<{ id: string }>(
    `insert into ledger_fx_revaluation_runs (
       command_source, idempotency_key, request_hash, operator_user_id, operator_email,
       reference, description, base_currency, revaluation_date, reversal_posting_date,
       rate_date, rate_source, unrealised_gain_account_id, unrealised_loss_account_id,
       revaluation_journal_id, reversal_journal_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning id`,
    [
      commandSource,
      idempotencyKey,
      hash,
      tx.actor.userId,
      tx.actor.email,
      reference,
      description,
      tx.baseCurrency,
      revaluationDate,
      reversalPostingDate,
      rateDate,
      rateSource,
      gain.id,
      loss.id,
      revaluationJournal.journal.id,
      reversalJournal.journal.id,
    ],
  );
  const runId = run.rows[0].id;
  for (const [index, item] of computed.entries()) {
    await tx.query(
      `insert into ledger_fx_revaluation_run_items (
         run_id, line_order, account_id, balance_type, currency_code, foreign_amount,
         carrying_amount, revalued_amount, closing_rate, delta_amount, description, revaluation_date
       ) values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11, $12)`,
      [
        runId,
        index + 1,
        item.account.id,
        item.account.accountClass,
        item.account.currencyCode,
        item.foreignAmount,
        item.carrying,
        item.revalued,
        item.balance.closingRate,
        toFixedString(item.delta, baseScale),
        item.balance.description,
        revaluationDate,
      ],
    );
  }

  await writeAuditEvent(tx, {
    eventType: "ledger.fx_revaluation_posted",
    entityType: "ledger_fx_revaluation_run",
    entityId: runId,
    details: {
      reference,
      revaluationDate,
      reversalPostingDate,
      rateDate,
      rateSource,
      revaluationJournalId: revaluationJournal.journal.id,
      reversalJournalId: reversalJournal.journal.id,
      balances: computed.map((item) => ({
        account: item.account.code,
        currency: item.account.currencyCode,
        foreignAmount: item.foreignAmount,
        closingRate: item.balance.closingRate,
        carrying: item.carrying,
        revalued: item.revalued,
        delta: toFixedString(item.delta, baseScale),
      })),
    },
  });

  const [created] = await loadRuns(tx, "where r.id = $1", [runId], 1);
  return { created: true, run: created };
}
