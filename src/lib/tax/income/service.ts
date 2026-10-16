import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { addDays, monthEndOf, monthStartOf } from "@/lib/financial-year";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, type Decimal, isPositive, isZero, parseDecimalInput, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { accountTotals, financialYearEndMonth, naturalAmount } from "@/lib/reports/financial";
import { assetAdjustments, listTaxAssets, type TaxAsset } from "@/lib/tax/income/assets";
import { buildIca, type Ica } from "@/lib/tax/income/ica";
import { ir4Return, type Ir4Return } from "@/lib/tax/income/ir4";
import { buildIr10, type Ir10 } from "@/lib/tax/income/ir10";
import { type InterestPeriod, requirements, underpaymentInterest } from "@/lib/tax/income/uomi";
import {
  EXPENSE_TREATMENTS,
  endOfYearTaxDue,
  INCOME_TREATMENTS,
  INTEREST_THRESHOLD,
  incomeYearDates,
  incomeYearLabel,
  incomeYearOf,
  isSupportedIncomeYear,
  money,
  NOT_REVIEWED_NOTE,
  shortDate,
  type OnTimeBy,
  onTimeBy,
  type ProvisionalSchedule,
  standardSchedule,
  TAXPAYER_TYPES,
  type TaxpayerType,
  TREATMENT_LABELS,
  TREATMENTS,
  type Treatment,
  type Workpaper,
  workpaper,
  type WorkpaperAccount,
  accountAdjustment,
  FIRST_SUPPORTED_INCOME_YEAR,
} from "@/lib/tax/income/rules";
import { optionalBoolean, optionalString, requireBoolean, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/*
 * Income tax, stage 1 (examples ITX1-ITX10, decision 545): the taxable income
 * workpaper from the books (and the overall budget for the rest of the year),
 * standard provisional tax, end-of-year tax and due dates. Owners and admins
 * only (the API checks). Nothing here posts, files or pays.
 */

export type IncomeTaxSettings = { taxpayerType: TaxpayerType | null; agentExtension: boolean; version: number; updatedByEmail: string | null; updatedAt: string };

type SettingsRow = { taxpayer_type: TaxpayerType | null; agent_extension: boolean; version: number; updated_by_email: string | null; updated_at: string };

function toSettings(row: SettingsRow): IncomeTaxSettings {
  return { taxpayerType: row.taxpayer_type, agentExtension: row.agent_extension, version: row.version, updatedByEmail: row.updated_by_email, updatedAt: new Date(row.updated_at).toISOString() };
}

export async function getIncomeTaxSettings(tx: OrgTx): Promise<IncomeTaxSettings> {
  const result = await tx.query<SettingsRow>("select taxpayer_type, agent_extension, version, updated_by_email, updated_at from income_tax_settings where id");
  return toSettings(result.rows[0]);
}

function requireVersion(input: unknown): number {
  const value = typeof input === "string" ? Number(input) : input;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ValidationError("version must be the version you loaded.");
  return value;
}

/** Company or individual, and whether a tax agent's extension of time applies (ITX1, ITX10). */
export async function updateIncomeTaxSettings(tx: OrgTx, input: { taxpayerType: unknown; agentExtension: unknown; version: unknown }): Promise<IncomeTaxSettings> {
  const taxpayerType = requireOneOf(input.taxpayerType, "taxpayerType", TAXPAYER_TYPES);
  const agentExtension = requireBoolean(input.agentExtension, "agentExtension");
  const version = requireVersion(input.version);
  const before = await getIncomeTaxSettings(tx);
  const updated = await tx.query<SettingsRow>(
    `update income_tax_settings set taxpayer_type = $1, agent_extension = $2, version = version + 1, updated_by_email = $3, updated_at = now()
      where id and version = $4
      returning taxpayer_type, agent_extension, version, updated_by_email, updated_at`,
    [taxpayerType, agentExtension, tx.actor.email, version],
  );
  if (!updated.rows[0]) throw new ConflictError("Someone else changed the income tax settings. Reload and try again.");
  await writeAuditEvent(tx, {
    eventType: "income_tax.settings_updated",
    entityType: "income_tax_settings",
    entityId: "settings",
    details: { from: { taxpayerType: before.taxpayerType, agentExtension: before.agentExtension }, to: { taxpayerType, agentExtension } },
  });
  return toSettings(updated.rows[0]);
}

// --- Account treatments --------------------------------------------------------

export type AccountTreatment = {
  accountId: string;
  code: string;
  name: string;
  side: "income" | "expense";
  isActive: boolean;
  treatment: Treatment;
  businessUsePercent: string | null;
  /** Set on this account, rather than the default. */
  isSet: boolean;
};

type TreatmentRow = {
  id: string;
  code: string;
  name: string;
  account_class: "revenue" | "expense";
  system_key: string | null;
  is_active: boolean;
  treatment: Treatment | null;
  business_use_percent: string | null;
};

function toTreatment(row: TreatmentRow): AccountTreatment {
  // The capital gains on disposal account starts as not taxable (ITX2).
  const fallback: Treatment = row.system_key === "fixed_asset_capital_gain" ? "not_taxable" : "full";
  return {
    accountId: row.id,
    code: row.code,
    name: row.name,
    side: row.account_class === "revenue" ? "income" : "expense",
    isActive: row.is_active,
    treatment: row.treatment ?? fallback,
    businessUsePercent: row.business_use_percent,
    isSet: row.treatment !== null,
  };
}

export async function listAccountTreatments(tx: OrgTx): Promise<AccountTreatment[]> {
  const result = await tx.query<TreatmentRow>(
    `select a.id::text, a.code, a.name, a.account_class, a.system_key, a.is_active, t.treatment, t.business_use_percent::text
       from accounts a left join account_tax_treatments t on t.account_id = a.id
      where a.account_class in ('revenue', 'expense')
      order by a.code, a.id`,
  );
  return result.rows.map(toTreatment);
}

/** Sets how an income or expense account counts for income tax (ITX2). */
export async function setAccountTreatment(tx: OrgTx, input: { accountId: unknown; treatment: unknown; businessUsePercent?: unknown }): Promise<AccountTreatment> {
  const accountId = requireId(input.accountId, "accountId");
  const treatment = requireOneOf(input.treatment, "treatment", TREATMENTS);
  const found = await tx.query<TreatmentRow>(
    `select a.id::text, a.code, a.name, a.account_class, a.system_key, a.is_active, t.treatment, t.business_use_percent::text
       from accounts a left join account_tax_treatments t on t.account_id = a.id where a.id = $1 for update of a`,
    [accountId],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Account not found.");
  if (row.account_class !== "revenue" && row.account_class !== "expense") throw new ValidationError(`${row.code} ${row.name} isn't an income or expense account, so it has no income tax treatment.`);
  const side = row.account_class === "revenue" ? "income" : "expense";
  const allowed = side === "income" ? INCOME_TREATMENTS : EXPENSE_TREATMENTS;
  if (!allowed.includes(treatment)) {
    throw new ValidationError(`${row.code} ${row.name} is an ${side} account: choose ${allowed.map((entry) => TREATMENT_LABELS[entry]).join(", ")}.`);
  }
  let percent: string | null = null;
  if (treatment === "business_use") {
    percent = parseDecimalInput(input.businessUsePercent, "businessUsePercent", { maxScale: 2, allowZero: true });
    if (cmp(dec(percent), dec("100")) >= 0) throw new ValidationError("businessUsePercent must be under 100 (100% business use counts in full).");
  }
  const before = toTreatment(row);
  await tx.query(
    `insert into account_tax_treatments (account_id, treatment, business_use_percent, updated_by_email) values ($1, $2, $3::numeric, $4)
     on conflict (account_id) do update set treatment = excluded.treatment, business_use_percent = excluded.business_use_percent,
       updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [accountId, treatment, percent, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "income_tax.treatment_set",
    entityType: "account",
    entityId: accountId,
    details: { code: row.code, from: { treatment: before.treatment, businessUsePercent: before.businessUsePercent }, to: { treatment, businessUsePercent: percent } },
  });
  return { ...before, treatment, businessUsePercent: percent, isSet: true };
}

// --- Typed IRD figures ---------------------------------------------------------

export type IncomeTaxYear = {
  incomeYear: number;
  assessedRit: string | null;
  returnFiledOn: string | null;
  lossesBroughtForward: string;
  taxCredits: string;
  otherIncome: string;
  /** IR10 box 1: more than one line of business. */
  multipleActivity: boolean;
  /** 0 until something's typed for the year. */
  version: number;
  updatedByEmail: string | null;
  updatedAt: string | null;
};

type YearRow = {
  income_year: number;
  assessed_rit: string | null;
  return_filed_on: string | null;
  losses_brought_forward: string;
  tax_credits: string;
  other_income: string;
  multiple_activity: boolean;
  version: number;
  updated_by_email: string | null;
  updated_at: string;
};

const YEAR_COLUMNS = "income_year, assessed_rit::text, return_filed_on::text, losses_brought_forward::text, tax_credits::text, other_income::text, multiple_activity, version, updated_by_email, updated_at";

function toYear(row: YearRow): IncomeTaxYear {
  return {
    incomeYear: row.income_year,
    assessedRit: row.assessed_rit,
    returnFiledOn: row.return_filed_on,
    lossesBroughtForward: row.losses_brought_forward,
    taxCredits: row.tax_credits,
    otherIncome: row.other_income,
    multipleActivity: row.multiple_activity,
    version: row.version,
    updatedByEmail: row.updated_by_email,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function emptyYear(incomeYear: number): IncomeTaxYear {
  return { incomeYear, assessedRit: null, returnFiledOn: null, lossesBroughtForward: "0.00", taxCredits: "0.00", otherIncome: "0.00", multipleActivity: false, version: 0, updatedByEmail: null, updatedAt: null };
}

export function requireIncomeYear(input: unknown): number {
  const value = typeof input === "string" && /^\d{4}$/.test(input.trim()) ? Number(input) : input;
  if (typeof value !== "number" || !Number.isInteger(value) || !isSupportedIncomeYear(value)) {
    throw new ValidationError(`incomeYear must be a year from ${FIRST_SUPPORTED_INCOME_YEAR} (the 2026 income year is 1 April 2025 to 31 March 2026).`);
  }
  return value;
}

export async function getIncomeTaxYear(tx: OrgTx, incomeYear: number): Promise<IncomeTaxYear> {
  const result = await tx.query<YearRow>(`select ${YEAR_COLUMNS} from income_tax_years where income_year = $1`, [incomeYear]);
  return result.rows[0] ? toYear(result.rows[0]) : emptyYear(incomeYear);
}

function amountOrZero(input: unknown, field: string, allowNegative = false): string {
  if (input == null || input === "") return "0";
  return parseDecimalInput(input, field, { maxScale: 2, allowZero: true, allowNegative });
}

/** Saves what IRD has for an income year, typed in (ITX3-ITX6). */
export async function saveIncomeTaxYear(
  tx: OrgTx,
  input: { incomeYear: unknown; assessedRit?: unknown; returnFiledOn?: unknown; lossesBroughtForward?: unknown; taxCredits?: unknown; otherIncome?: unknown; multipleActivity?: unknown; version: unknown },
): Promise<IncomeTaxYear> {
  const incomeYear = requireIncomeYear(input.incomeYear);
  const version = typeof input.version === "number" && input.version === 0 ? 0 : requireVersion(input.version);
  const assessedRit = input.assessedRit == null || input.assessedRit === "" ? null : parseDecimalInput(input.assessedRit, "assessedRit", { maxScale: 2, allowZero: true });
  const returnFiledOn = input.returnFiledOn == null || input.returnFiledOn === "" ? null : parseIsoDate(input.returnFiledOn, "returnFiledOn");
  if ((assessedRit === null) !== (returnFiledOn === null)) {
    throw new ValidationError("Type both IRD's assessed RIT and the date the return was filed, or neither.");
  }
  const yearEnd = incomeYearDates(incomeYear, await financialYearEndMonth(tx)).end;
  if (returnFiledOn !== null && returnFiledOn <= yearEnd) throw new ValidationError(`The ${incomeYear} return can't be filed before the income year ends on ${shortDate(yearEnd)}.`);
  const losses = amountOrZero(input.lossesBroughtForward, "lossesBroughtForward");
  const credits = amountOrZero(input.taxCredits, "taxCredits");
  const otherIncome = amountOrZero(input.otherIncome, "otherIncome", true);
  const multipleActivity = optionalBoolean(input.multipleActivity, "multipleActivity") ?? false;
  const before = await getIncomeTaxYear(tx, incomeYear);
  if (before.version !== version) throw new ConflictError(`Someone else changed the ${incomeYear} figures. Reload and try again.`);
  const saved = await tx.query<YearRow>(
    `insert into income_tax_years (income_year, assessed_rit, return_filed_on, losses_brought_forward, tax_credits, other_income, multiple_activity, updated_by_email)
     values ($1, $2::numeric, $3::date, $4::numeric, $5::numeric, $6::numeric, $8, $7)
     on conflict (income_year) do update set assessed_rit = excluded.assessed_rit, return_filed_on = excluded.return_filed_on,
       losses_brought_forward = excluded.losses_brought_forward, tax_credits = excluded.tax_credits, other_income = excluded.other_income,
       multiple_activity = excluded.multiple_activity, version = income_tax_years.version + 1, updated_by_email = excluded.updated_by_email, updated_at = now()
     returning ${YEAR_COLUMNS}`,
    [incomeYear, assessedRit, returnFiledOn, losses, credits, otherIncome, tx.actor.email, multipleActivity],
  );
  const after = toYear(saved.rows[0]);
  await writeAuditEvent(tx, {
    eventType: "income_tax.year_saved",
    entityType: "income_tax_year",
    entityId: String(incomeYear),
    details: {
      from: { assessedRit: before.assessedRit, returnFiledOn: before.returnFiledOn, lossesBroughtForward: before.lossesBroughtForward, taxCredits: before.taxCredits, otherIncome: before.otherIncome, multipleActivity: before.multipleActivity },
      to: { assessedRit: after.assessedRit, returnFiledOn: after.returnFiledOn, lossesBroughtForward: after.lossesBroughtForward, taxCredits: after.taxCredits, otherIncome: after.otherIncome, multipleActivity: after.multipleActivity },
    },
  });
  return after;
}

// --- Typed adjustments and payments -----------------------------------------

export type TaxAdjustment = { id: string; incomeYear: number; description: string; amount: string; createdByEmail: string | null; createdAt: string };
export type TaxPayment = { id: string; incomeYear: number; paidOn: string; amount: string; note: string | null; createdByEmail: string | null; createdAt: string };

type AdjustmentRow = { id: string; request_hash: string; income_year: number; description: string; amount: string; created_by_email: string | null; created_at: string };
type PaymentRow = { id: string; request_hash: string; income_year: number; paid_on: string; amount: string; note: string | null; created_by_email: string | null; created_at: string };

const toAdjustment = (row: AdjustmentRow): TaxAdjustment => ({ id: row.id, incomeYear: row.income_year, description: row.description, amount: row.amount, createdByEmail: row.created_by_email, createdAt: new Date(row.created_at).toISOString() });
const toPayment = (row: PaymentRow): TaxPayment => ({ id: row.id, incomeYear: row.income_year, paidOn: row.paid_on, amount: row.amount, note: row.note, createdByEmail: row.created_by_email, createdAt: new Date(row.created_at).toISOString() });

const ADJUSTMENT_COLUMNS = "id::text, request_hash, income_year, description, amount::text, created_by_email, created_at";
const PAYMENT_COLUMNS = "id::text, request_hash, income_year, paid_on::text, amount::text, note, created_by_email, created_at";

export async function listAdjustments(tx: OrgTx, incomeYear: number): Promise<TaxAdjustment[]> {
  const result = await tx.query<AdjustmentRow>(`select ${ADJUSTMENT_COLUMNS} from income_tax_adjustments where income_year = $1 order by income_tax_adjustments.id`, [incomeYear]);
  return result.rows.map(toAdjustment);
}

export async function listPayments(tx: OrgTx, incomeYear: number): Promise<TaxPayment[]> {
  const result = await tx.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from income_tax_payments where income_year = $1 order by paid_on, income_tax_payments.id`, [incomeYear]);
  return result.rows.map(toPayment);
}

/** A typed adjustment to taxable income: positive adds, negative takes off (ITX3). */
export async function addAdjustment(tx: OrgTx, input: { idempotencyKey: unknown; incomeYear: unknown; description: unknown; amount: unknown }): Promise<{ created: boolean; adjustment: TaxAdjustment }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const incomeYear = requireIncomeYear(input.incomeYear);
  const description = requireString(input.description, "description", { maxLength: 200 });
  const amount = parseDecimalInput(input.amount, "amount", { maxScale: 2, allowNegative: true });
  const hash = requestHash("income_tax_adjustment", { incomeYear, description, amount });
  const existing = await tx.query<AdjustmentRow>(`select ${ADJUSTMENT_COLUMNS} from income_tax_adjustments where idempotency_key = $1`, [idempotencyKey]);
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "income tax adjustment");
    return { created: false, adjustment: toAdjustment(existing.rows[0]) };
  }
  const inserted = await tx.query<AdjustmentRow>(
    `insert into income_tax_adjustments (idempotency_key, request_hash, income_year, description, amount, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6) returning ${ADJUSTMENT_COLUMNS}`,
    [idempotencyKey, hash, incomeYear, description, amount, tx.actor.email],
  );
  const adjustment = toAdjustment(inserted.rows[0]);
  await writeAuditEvent(tx, { eventType: "income_tax.adjustment_added", entityType: "income_tax_adjustment", entityId: adjustment.id, details: { incomeYear, description, amount } });
  return { created: true, adjustment };
}

export async function removeAdjustment(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "adjustmentId");
  const removed = await tx.query<AdjustmentRow>(`delete from income_tax_adjustments where id = $1 returning ${ADJUSTMENT_COLUMNS}`, [id]);
  const row = removed.rows[0];
  if (!row) throw new NotFoundError("Adjustment not found.");
  await writeAuditEvent(tx, { eventType: "income_tax.adjustment_removed", entityType: "income_tax_adjustment", entityId: id, details: { incomeYear: row.income_year, description: row.description, amount: row.amount } });
}

/** A payment made to IRD towards an income year's tax, typed in (ITX6, ITX9). */
export async function addPayment(tx: OrgTx, input: { idempotencyKey: unknown; incomeYear: unknown; paidOn: unknown; amount: unknown; note?: unknown }): Promise<{ created: boolean; payment: TaxPayment }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const incomeYear = requireIncomeYear(input.incomeYear);
  const paidOn = parseIsoDate(input.paidOn, "paidOn");
  const amount = parseDecimalInput(input.amount, "amount", { maxScale: 2 });
  const note = optionalString(input.note, "note", { maxLength: 200 });
  const hash = requestHash("income_tax_payment", { incomeYear, paidOn, amount, note });
  const existing = await tx.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from income_tax_payments where idempotency_key = $1`, [idempotencyKey]);
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "income tax payment");
    return { created: false, payment: toPayment(existing.rows[0]) };
  }
  if (paidOn < `${incomeYear - 2}-04-01`) {
    throw new ValidationError(`A payment on ${paidOn} is too early to be towards the ${incomeYear} income year.`);
  }
  const inserted = await tx.query<PaymentRow>(
    `insert into income_tax_payments (idempotency_key, request_hash, income_year, paid_on, amount, note, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6, $7) returning ${PAYMENT_COLUMNS}`,
    [idempotencyKey, hash, incomeYear, paidOn, amount, note, tx.actor.email],
  );
  const payment = toPayment(inserted.rows[0]);
  await writeAuditEvent(tx, { eventType: "income_tax.payment_added", entityType: "income_tax_payment", entityId: payment.id, details: { incomeYear, paidOn, amount, note } });
  return { created: true, payment };
}

export async function removePayment(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "paymentId");
  const removed = await tx.query<PaymentRow>(`delete from income_tax_payments where id = $1 returning ${PAYMENT_COLUMNS}`, [id]);
  const row = removed.rows[0];
  if (!row) throw new NotFoundError("Payment not found.");
  await writeAuditEvent(tx, { eventType: "income_tax.payment_removed", entityType: "income_tax_payment", entityId: id, details: { incomeYear: row.income_year, paidOn: row.paid_on, amount: row.amount } });
}

// --- The income tax report --------------------------------------------------------

export type ReportAccount = {
  accountId: string;
  code: string;
  name: string;
  side: "income" | "expense";
  actual: string;
  budget: string;
  total: string;
  treatment: Treatment;
  businessUsePercent: string | null;
  adjustment: string;
};

export type DueDate = { key: string; label: string; dueDate: string; onTimeBy: OnTimeBy; amount: string | null; estimate: boolean };

export type IncomeTaxReport =
  | { supported: false; reason: string; settings: IncomeTaxSettings; incomeYear: number; years: number[]; endMonth: number }
  | {
      supported: true;
      settings: IncomeTaxSettings & { taxpayerType: TaxpayerType };
      incomeYear: number;
      label: string;
      /** The balance date's month (3 for 31 March). */
      endMonth: number;
      start: string;
      end: string;
      years: number[];
      reviewNote: string;
      actualsTo: string | null;
      budgetFrom: string | null;
      budgetName: string | null;
      accounts: ReportAccount[];
      typed: IncomeTaxYear;
      taxAssets: TaxAsset[];
      /** Use-of-money interest, an estimate (ITX44-ITX48). */
      interest: {
        rit: string;
        ritTyped: boolean;
        soFar: { asAt: string; amount: string; periods: InterestPeriod[] };
        /** If the remaining instalments and end-of-year tax are paid on their dates; null without an end-of-year date. */
        ifPaidOnTime: string | null;
        usesLatestRateForFuture: boolean;
        ratesKnownTo: string;
      };
      /** The IR10, once the income year has ended (ITX24). */
      ir10: Ir10 | null;
      /** A company's imputation credit account for the ICA year matching this income year (ITX25-ITX28). */
      ica: Ica | null;
      /** A company's IR4 income and tax calculation boxes, once the income year has ended (ITX50-ITX53). */
      ir4: Ir4Return | null;
      adjustments: TaxAdjustment[];
      payments: TaxPayment[];
      paidTotal: string;
      workpaper: Workpaper;
      lastYear: { incomeYear: number; rit: string | null; typed: boolean; filedOn: string | null };
      twoYearsAgo: { incomeYear: number; rit: string | null };
      provisional: ProvisionalSchedule;
      endOfYear: { rit: string; provisional: string; amount: string; dueDate: string | null; onTimeBy: OnTimeBy | null; agentExtension: boolean };
      dueDates: DueDate[];
      notes: string[];
    };

type Line = { accountId: string; code: string; name: string; side: "income" | "expense"; actual: Decimal; budget: Decimal };

/** Income and expense amounts for the income year: actuals to the last whole month, the overall budget after (ITX9). */
async function yearAmounts(tx: OrgTx, year: number, today: string, withBudget: boolean): Promise<{ lines: Map<string, Line>; actualsTo: string | null; budgetFrom: string | null; budgetName: string | null; hasActivity: boolean }> {
  const { start, end } = incomeYearDates(year, await financialYearEndMonth(tx));
  const lastWholeMonth = monthEndOf(addDays(monthStartOf(today), -1));
  const actualsTo = end <= lastWholeMonth ? end : lastWholeMonth >= start ? lastWholeMonth : null;
  const lines = new Map<string, Line>();
  const accounts = await listAccountTreatments(tx);
  const byId = new Map(accounts.map((account) => [account.accountId, account]));
  let hasActivity = false;
  if (actualsTo) {
    for (const row of await accountTotals(tx, start, actualsTo)) {
      const account = byId.get(row.id);
      if (!account) continue;
      const amount = naturalAmount(row);
      if (isZero(amount)) continue;
      hasActivity = true;
      lines.set(row.id, { accountId: row.id, code: row.code, name: row.name, side: account.side, actual: amount, budget: ZERO_DECIMAL });
    }
  }
  let budgetFrom: string | null = null;
  let budgetName: string | null = null;
  if (withBudget && (actualsTo === null || actualsTo < end)) {
    budgetFrom = actualsTo === null ? start : addDays(actualsTo, 1);
    const budget = await tx.query<{ name: string; account_id: string; amount: string }>(
      `select b.name, a.account_id::text, sum(a.amount)::text as amount
         from budgets b join budget_amounts a on a.budget_id = b.id
        where b.is_overall and a.month between $1::date and $2::date
        group by b.name, a.account_id`,
      [budgetFrom, end],
    );
    const named = await tx.query<{ name: string }>("select name from budgets where is_overall");
    budgetName = named.rows[0]?.name ?? null;
    for (const row of budget.rows) {
      const account = byId.get(row.account_id);
      if (!account || isZero(dec(row.amount))) continue;
      const line = lines.get(row.account_id) ?? { accountId: account.accountId, code: account.code, name: account.name, side: account.side, actual: ZERO_DECIMAL, budget: ZERO_DECIMAL };
      line.budget = add(line.budget, dec(row.amount));
      lines.set(row.account_id, line);
    }
  }
  return { lines, actualsTo, budgetFrom, budgetName, hasActivity };
}

async function treatmentsById(tx: OrgTx): Promise<Map<string, AccountTreatment>> {
  return new Map((await listAccountTreatments(tx)).map((entry) => [entry.accountId, entry]));
}

function toWorkpaperAccounts(lines: Iterable<Line>, treatments: Map<string, AccountTreatment>): WorkpaperAccount[] {
  return [...lines]
    .sort((a, b) => a.code.localeCompare(b.code) || a.accountId.localeCompare(b.accountId))
    .map((line) => {
      const treatment = treatments.get(line.accountId);
      return {
        accountId: line.accountId,
        code: line.code,
        name: line.name,
        side: line.side,
        amount: add(line.actual, line.budget),
        treatment: treatment?.treatment ?? "full",
        businessUsePercent: treatment?.businessUsePercent ? dec(treatment.businessUsePercent) : null,
      };
    });
}

/** Tohyee's estimate of a past year's RIT from the books, or null when the books have nothing for it. */
async function estimatedRit(tx: OrgTx, type: TaxpayerType, year: number, today: string): Promise<Decimal | null> {
  if (!isSupportedIncomeYear(year)) return null;
  const amounts = await yearAmounts(tx, year, today, false);
  if (!amounts.hasActivity) return null;
  const typed = await getIncomeTaxYear(tx, year);
  const treatments = await treatmentsById(tx);
  const fromAssets = await assetAdjustments(tx, year, treatments, null);
  const result = workpaper({
    type,
    year,
    accounts: toWorkpaperAccounts(amounts.lines.values(), treatments),
    typedAdjustments: [...fromAssets.adjustments, ...(await listAdjustments(tx, year)).map((entry) => ({ description: entry.description, amount: dec(entry.amount) }))],
    otherIncome: dec(typed.otherIncome),
    lossesBroughtForward: dec(typed.lossesBroughtForward),
    taxCredits: dec(typed.taxCredits),
  });
  return dec(result.rit);
}

function sumPayments(payments: TaxPayment[]): Decimal {
  return payments.reduce((total, payment) => add(total, dec(payment.amount)), ZERO_DECIMAL);
}

/** The income tax workspace for an income year (ITX1-ITX10). */
export async function buildIncomeTax(tx: OrgTx, input: { incomeYear?: unknown; today?: string }): Promise<IncomeTaxReport> {
  const today = input.today ?? todayIsoDate();
  const endMonth = await financialYearEndMonth(tx);
  const current = incomeYearOf(today, endMonth);
  const incomeYear = input.incomeYear == null || input.incomeYear === "" ? Math.max(current, FIRST_SUPPORTED_INCOME_YEAR) : requireIncomeYear(input.incomeYear);
  const years: number[] = [];
  for (let year = Math.max(current + 1, FIRST_SUPPORTED_INCOME_YEAR); year >= FIRST_SUPPORTED_INCOME_YEAR; year -= 1) years.push(year);
  const settings = await getIncomeTaxSettings(tx);
  if (!settings.taxpayerType) {
    return { supported: false, reason: "Choose whether this organisation is a company or an individual (sole trader) to see its income tax.", settings, incomeYear, years, endMonth };
  }
  const type = settings.taxpayerType;
  const { start, end } = incomeYearDates(incomeYear, endMonth);
  const amounts = await yearAmounts(tx, incomeYear, today, true);
  const treatments = await treatmentsById(tx);
  const accounts = toWorkpaperAccounts(amounts.lines.values(), treatments);
  const typed = await getIncomeTaxYear(tx, incomeYear);
  const adjustments = await listAdjustments(tx, incomeYear);
  const payments = await listPayments(tx, incomeYear);
  const fromAssets = await assetAdjustments(tx, incomeYear, treatments, amounts.budgetFrom);
  const taxAssets = await listTaxAssets(tx, incomeYear);
  const paper = workpaper({
    type,
    year: incomeYear,
    accounts,
    typedAdjustments: [...fromAssets.adjustments, ...adjustments.map((entry) => ({ description: entry.description, amount: dec(entry.amount) }))],
    otherIncome: dec(typed.otherIncome),
    lossesBroughtForward: dec(typed.lossesBroughtForward),
    taxCredits: dec(typed.taxCredits),
  });

  // Last year's RIT: IRD's typed figure, or Tohyee's estimate from the books (ITX5, ITX6).
  const lastYearNumber = incomeYear - 1;
  const lastTyped = isSupportedIncomeYear(lastYearNumber) ? await getIncomeTaxYear(tx, lastYearNumber) : emptyYear(lastYearNumber);
  let lastYear: { amount: Decimal; typed: boolean } | null = null;
  if (lastTyped.assessedRit !== null) lastYear = { amount: dec(lastTyped.assessedRit), typed: true };
  else {
    const estimate = await estimatedRit(tx, type, lastYearNumber, today);
    if (estimate) lastYear = { amount: estimate, typed: false };
  }
  const twoTyped = await tx.query<{ assessed_rit: string | null }>("select assessed_rit::text from income_tax_years where income_year = $1", [incomeYear - 2]);
  const twoYearsAgo = twoTyped.rows[0]?.assessed_rit ?? null;
  const settingsRow = await tx.query<{ gst_period_months: number | null }>("select gst_period_months from organisation_settings where id = true");
  const instalmentCount = settingsRow.rows[0]?.gst_period_months === 6 ? 2 : 3;
  const provisional = standardSchedule({
    year: incomeYear,
    instalmentCount,
    lastYear,
    lastYearFiledOn: lastTyped.returnFiledOn,
    twoYearsAgo: twoYearsAgo === null ? null : dec(twoYearsAgo),
    payments: payments.map((payment) => ({ date: payment.paidOn, amount: dec(payment.amount) })),
    today,
    endMonth,
  });

  // End-of-year tax: this year's RIT less provisional tax (the instalments, or what's been paid if more) (ITX9).
  const paid = sumPayments(payments);
  const scheduled = provisional.kind === "schedule" ? dec(provisional.total) : ZERO_DECIMAL;
  const provisionalExpected = cmp(paid, scheduled) > 0 ? paid : scheduled;
  const endDue = endOfYearTaxDue(incomeYear, settings.agentExtension, endMonth);
  const endAmount = sub(dec(paper.rit), provisionalExpected);
  const endOfYear = { rit: paper.rit, provisional: money(provisionalExpected), amount: money(endAmount), dueDate: endDue, onTimeBy: endDue ? onTimeBy(endDue) : null, agentExtension: settings.agentExtension };

  const dueDates: DueDate[] = [];
  if (isSupportedIncomeYear(lastYearNumber)) {
    const lastDue = endOfYearTaxDue(lastYearNumber, settings.agentExtension, endMonth);
    const lastPaid = sumPayments(await listPayments(tx, lastYearNumber));
    if (lastDue) dueDates.push({
      key: `end-${lastYearNumber}`,
      label: `End-of-year tax for the ${lastYearNumber} income year`,
      dueDate: lastDue,
      onTimeBy: onTimeBy(lastDue),
      amount: lastYear ? money(sub(lastYear.amount, lastPaid)) : null,
      estimate: !lastYear?.typed,
    });
  }
  if (provisional.kind === "schedule") {
    for (const instalment of provisional.instalments) {
      dueDates.push({ key: `instalment-${instalment.number}`, label: `Provisional tax instalment ${instalment.number} for the ${incomeYear} income year`, dueDate: instalment.dueDate, onTimeBy: instalment.onTimeBy, amount: instalment.amount, estimate: instalment.estimate });
    }
  }
  if (endDue) dueDates.push({ key: `end-${incomeYear}`, label: `End-of-year tax for the ${incomeYear} income year`, dueDate: endDue, onTimeBy: onTimeBy(endDue), amount: endOfYear.amount, estimate: true });
  dueDates.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // Use-of-money interest, an estimate (ITX44-ITX48): on IRD's RIT once typed, Tohyee's figure before then.
  const interestRit = typed.assessedRit !== null ? dec(typed.assessedRit) : dec(paper.rit);
  const due = requirements({
    rit: interestRit,
    instalments: provisional.kind === "schedule" ? provisional.instalments.map((entry) => ({ due: entry.onTimeBy.date, amount: dec(entry.amount) })) : null,
    endOfYearDue: endOfYear.onTimeBy?.date ?? null,
  });
  const paidSoFar = payments.map((payment) => ({ date: payment.paidOn, amount: dec(payment.amount) }));
  const soFar = underpaymentInterest({ requirements: due, payments: paidSoFar.filter((payment) => payment.date <= today), asAt: today, today });
  let ifPaidOnTime: string | null = null;
  if (endOfYear.onTimeBy) {
    const endDate = endOfYear.onTimeBy.date;
    const scheduled = provisional.kind === "schedule" ? provisional.instalments.filter((entry) => entry.onTimeBy.date > today).map((entry) => ({ date: entry.onTimeBy.date, amount: dec(entry.amount) })) : [];
    const planned = [...paidSoFar, ...scheduled];
    const rest = sub(interestRit, planned.reduce((sum, payment) => add(sum, payment.amount), ZERO_DECIMAL));
    if (isPositive(rest)) planned.push({ date: endDate, amount: rest });
    ifPaidOnTime = underpaymentInterest({ requirements: due, payments: planned, asAt: endDate > today ? endDate : today, today }).interest;
  }
  const interest = {
    rit: money(interestRit),
    ritTyped: typed.assessedRit !== null,
    soFar: { asAt: today, amount: soFar.interest, periods: soFar.periods },
    ifPaidOnTime,
    usesLatestRateForFuture: true,
    ratesKnownTo: soFar.ratesKnownTo,
  };

  // The IR10 once the income year has ended and the figures are all actuals (ITX24).
  const yearEnded = amounts.actualsTo === end && amounts.budgetFrom === null;
  const ir10 = yearEnded ? await buildIr10(tx, { incomeYear, workpaper: paper, multipleActivity: typed.multipleActivity, treatments }) : null;
  const ir4 = yearEnded && type === "company" ? ir4Return({ workpaper: paper, paidTowardsYear: paid }) : null;

  const notes: string[] = [];
  if (!endDue) {
    notes.push(
      "For a balance date from April to September, Tohyee doesn't work out the end-of-year tax due date yet: the Income Tax Act's schedule 3 gives the month (February, or April with a tax agent's extension), and which year that falls in still needs checking. Check the date in myIR.",
    );
  }
  if (endMonth !== 3) notes.push(`The ${incomeYear} income year runs ${shortDate(start)} to ${shortDate(end)} (IRD SPS 24/01). The provisional tax dates follow the balance date (Income Tax Act 2007 schedule 3).`);
  if (amounts.budgetFrom) {
    const hasBudget = [...amounts.lines.values()].some((line) => !isZero(line.budget));
    notes.push(
      hasBudget
        ? `From ${shortDate(amounts.budgetFrom)} to ${shortDate(end)} the figures come from the ${amounts.budgetName ?? "overall budget"}, not actuals, so this year's tax is a forecast.`
        : `There's nothing in the overall budget from ${shortDate(amounts.budgetFrom)} to ${shortDate(end)}, so this year's figures are actuals only so far.`,
    );
  }
  if (fromAssets.notSetUp.length > 0) {
    const shown = fromAssets.notSetUp.slice(0, 10).join(", ") + (fromAssets.notSetUp.length > 10 ? ` and ${fromAssets.notSetUp.length - 10} more` : "");
    notes.push(`These fixed assets have no tax details, so their book depreciation stands in for tax depreciation: ${shown}. Give them tax details under Tax depreciation.`);
  }
  if (fromAssets.budgetedDepreciationAccounts.length > 0) {
    notes.push(`The budget for the rest of the year has depreciation on ${fromAssets.budgetedDepreciationAccounts.join(", ")}, which stays in alongside these assets' full-year tax depreciation. Take it out of the budget, or add an adjustment.`);
  }
  notes.push("Depreciation posted by journals outside the fixed asset register stays as booked.");
  if (type === "company" && !isZero(dec(typed.lossesBroughtForward))) notes.push("A company can use losses brought forward only if its shareholding has stayed continuous enough; check before relying on them.");
  if (type === "individual") notes.push("The ACC earners' levy, independent earner tax credit, Working for Families and student loan repayments aren't worked out.");
  notes.push(
    cmp(dec(paper.rit), INTEREST_THRESHOLD) < 0
      ? "With RIT under 60,000.00 on the standard option, IRD charges or pays interest only from the day after the end-of-year tax date. The interest shown is an estimate; IRD works out what it charges."
      : "With RIT of 60,000.00 or more, IRD can charge interest from the day after the last instalment on any shortfall (and earlier if an instalment is paid late or short). The interest shown is an estimate; IRD works out what it charges.",
  );
  if (dueDates.some((entry) => !entry.onTimeBy.holidaysChecked)) notes.push("Some dates are in years not on Tohyee's public holiday list, so only weekends move them.");
  notes.push("Regional anniversary days aren't checked.");

  return {
    supported: true,
    settings: { ...settings, taxpayerType: type },
    incomeYear,
    label: incomeYearLabel(incomeYear, endMonth),
    endMonth,
    start,
    end,
    years,
    reviewNote: NOT_REVIEWED_NOTE,
    actualsTo: amounts.actualsTo,
    budgetFrom: amounts.budgetFrom,
    budgetName: amounts.budgetName,
    accounts: accounts.map((account) => {
      const line = amounts.lines.get(account.accountId)!;
      return {
        accountId: account.accountId,
        code: account.code,
        name: account.name,
        side: account.side,
        actual: money(line.actual),
        budget: money(line.budget),
        total: money(account.amount),
        treatment: account.treatment,
        businessUsePercent: account.businessUsePercent ? treatments.get(account.accountId)?.businessUsePercent ?? null : null,
        adjustment: money(accountAdjustment(account)),
      };
    }),
    typed,
    taxAssets,
    ir10,
    ir4,
    interest,
    ica: type === "company" ? await buildIca(tx, incomeYear) : null,
    adjustments,
    payments,
    paidTotal: money(paid),
    workpaper: paper,
    lastYear: { incomeYear: lastYearNumber, rit: lastYear ? money(lastYear.amount) : null, typed: lastYear?.typed ?? false, filedOn: lastTyped.returnFiledOn },
    twoYearsAgo: { incomeYear: incomeYear - 2, rit: twoYearsAgo },
    provisional,
    endOfYear,
    dueDates,
    notes,
  };
}
