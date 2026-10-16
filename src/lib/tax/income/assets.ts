import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { COUNTING_LINES_SQL } from "@/lib/fixed-assets/service";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { add, cmp, dec, type Decimal, divide, isZero, mul, parseDecimalInput, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  INVESTMENT_BOOST_FROM,
  LOW_VALUE_FROM,
  LOW_VALUE_LIMIT,
  TAX_DEPRECIATION_METHOD_LABELS,
  TAX_DEPRECIATION_METHODS,
  type TaxAssetYear,
  type TaxDepreciationMethod,
  taxDepreciationYears,
} from "@/lib/tax/income/depreciation";
import { incomeYearDates, incomeYearOf, isSupportedIncomeYear, money, type Treatment } from "@/lib/tax/income/rules";
import { optionalBoolean, requireId, requireOneOf } from "@/lib/validation";

/*
 * The tax side of the fixed asset register (examples ITX11-ITX18, decision
 * 546): each asset's tax details, its tax depreciation for an income year,
 * and the lines that swap its book figures for tax ones in the taxable income
 * workpaper. Owners and admins only (the API checks). Nothing posts.
 */

export type TaxDetails = {
  method: TaxDepreciationMethod;
  rate: string | null;
  taxCost: string;
  businessUsePercent: string;
  availableOn: string;
  newAsset: boolean;
  investmentBoost: boolean;
  openingIncomeYear: number | null;
  openingAtv: string | null;
  version: number;
  updatedByEmail: string | null;
  updatedAt: string;
};

export type TaxAsset = {
  assetId: string;
  assetNumber: string;
  name: string;
  typeName: string;
  status: "registered" | "disposed";
  purchaseDate: string;
  cost: string;
  bookMethod: string;
  bookRate: string | null;
  disposal: { date: string; proceeds: string } | null;
  details: TaxDetails | null;
  /** This income year's figures, or null without tax details or before the asset's first year. */
  year: TaxAssetYear | null;
};

type AssetRow = {
  id: string;
  asset_number: string;
  name: string;
  type_name: string;
  depreciation_account_id: string;
  status: "registered" | "disposed";
  purchase_date: string;
  cost: string;
  method: string;
  rate: string | null;
  disposal_date: string | null;
  proceeds: string | null;
  d_method: TaxDepreciationMethod | null;
  d_rate: string | null;
  tax_cost: string | null;
  business_use_percent: string | null;
  available_on: string | null;
  new_asset: boolean | null;
  investment_boost: boolean | null;
  opening_income_year: number | null;
  opening_atv: string | null;
  version: number | null;
  updated_by_email: string | null;
  updated_at: string | null;
};

const ASSETS_SQL = `select f.id::text, f.asset_number, f.name, t.name as type_name, t.depreciation_expense_account_id::text as depreciation_account_id,
       f.status, f.purchase_date::text, f.cost::text, f.method, f.rate::text,
       d.disposal_date::text, d.proceeds::text,
       x.method as d_method, x.rate::text as d_rate, x.tax_cost::text, x.business_use_percent::text, x.available_on::text, x.new_asset,
       x.investment_boost, x.opening_income_year, x.opening_atv::text, x.version, x.updated_by_email, x.updated_at
  from fixed_assets f
  join fixed_asset_types t on t.id = f.type_id
  left join fixed_asset_disposals d on d.asset_id = f.id and d.status = 'active'
  left join fixed_asset_tax_details x on x.asset_id = f.id`;

function toDetails(row: AssetRow): TaxDetails | null {
  if (!row.d_method) return null;
  return {
    method: row.d_method,
    rate: row.d_rate,
    taxCost: money(dec(row.tax_cost!)),
    businessUsePercent: row.business_use_percent!,
    availableOn: row.available_on!,
    newAsset: row.new_asset!,
    investmentBoost: row.investment_boost!,
    openingIncomeYear: row.opening_income_year,
    openingAtv: row.opening_atv === null ? null : money(dec(row.opening_atv)),
    version: row.version!,
    updatedByEmail: row.updated_by_email,
    updatedAt: new Date(row.updated_at!).toISOString(),
  };
}

function yearFor(row: AssetRow, details: TaxDetails | null, incomeYear: number, endMonth: number): TaxAssetYear | null {
  if (!details) return null;
  const rows = taxDepreciationYears(
    {
      cost: dec(details.taxCost),
      method: details.method,
      rate: details.rate === null ? null : dec(details.rate),
      businessUsePercent: dec(details.businessUsePercent),
      investmentBoost: details.investmentBoost,
      availableOn: details.availableOn,
      opening: details.openingIncomeYear === null ? null : { incomeYear: details.openingIncomeYear, atv: dec(details.openingAtv!) },
      disposal: row.disposal_date ? { date: row.disposal_date, proceeds: dec(row.proceeds!) } : null,
      endMonth,
    },
    incomeYear,
  );
  return rows.find((entry) => entry.incomeYear === incomeYear) ?? null;
}

function toAsset(row: AssetRow, incomeYear: number, endMonth: number): TaxAsset {
  const details = toDetails(row);
  return {
    assetId: row.id,
    assetNumber: row.asset_number,
    name: row.name,
    typeName: row.type_name,
    status: row.status,
    purchaseDate: row.purchase_date,
    cost: money(dec(row.cost)),
    bookMethod: row.method,
    bookRate: row.rate,
    disposal: row.disposal_date ? { date: row.disposal_date, proceeds: money(dec(row.proceeds!)) } : null,
    details,
    year: yearFor(row, details, incomeYear, endMonth),
  };
}

/** Fixed assets in use or disposed, with their tax details and this income year's tax figures (ITX11-ITX17). */
export async function listTaxAssets(tx: OrgTx, incomeYear: number): Promise<TaxAsset[]> {
  const result = await tx.query<AssetRow>(`${ASSETS_SQL} where f.status in ('registered', 'disposed') order by f.asset_number`);
  const endMonth = await financialYearEndMonth(tx);
  return result.rows.map((row) => toAsset(row, incomeYear, endMonth));
}

function versionOf(input: unknown): number {
  const value = typeof input === "string" ? Number(input) : input;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ValidationError("version must be the version you loaded (0 for none yet).");
  return value;
}

/** Sets a fixed asset's tax details (ITX11, ITX14, ITX17). */
export async function setTaxDetails(
  tx: OrgTx,
  assetIdInput: unknown,
  input: {
    method: unknown;
    rate?: unknown;
    taxCost?: unknown;
    businessUsePercent?: unknown;
    availableOn?: unknown;
    newAsset?: unknown;
    investmentBoost?: unknown;
    openingIncomeYear?: unknown;
    openingAtv?: unknown;
    version: unknown;
  },
): Promise<TaxAsset> {
  const assetId = requireId(assetIdInput, "assetId");
  const found = await tx.query<AssetRow>(`${ASSETS_SQL} where f.id = $1 for update of f`, [assetId]);
  const row = found.rows[0];
  if (!row || (row.status !== "registered" && row.status !== "disposed")) throw new NotFoundError("Fixed asset not found.");
  const label = `${row.asset_number} ${row.name}`;
  const endMonth = await financialYearEndMonth(tx);
  const method = requireOneOf(input.method, "method", TAX_DEPRECIATION_METHODS);
  const depreciating = method === "dv" || method === "sl";
  const rate = depreciating ? parseDecimalInput(input.rate, "rate", { maxScale: 4 }) : null;
  if (rate !== null && cmp(dec(rate), dec("100")) > 0) throw new ValidationError("rate is a percentage: 30 means 30%.");
  const taxCost = input.taxCost == null || input.taxCost === "" ? money(dec(row.cost)) : parseDecimalInput(input.taxCost, "taxCost", { maxScale: 2 });
  const businessUse = input.businessUsePercent == null || input.businessUsePercent === "" ? "100" : parseDecimalInput(input.businessUsePercent, "businessUsePercent", { maxScale: 2 });
  if (cmp(dec(businessUse), dec("100")) > 0) throw new ValidationError("businessUsePercent can be at most 100.");
  const availableOn = input.availableOn == null || input.availableOn === "" ? row.purchase_date : parseIsoDate(input.availableOn, "availableOn");
  if (availableOn < row.purchase_date) throw new ValidationError(`${label} can't be available for use before it was bought on ${row.purchase_date}.`);
  const newAsset = optionalBoolean(input.newAsset, "newAsset") ?? false;
  const investmentBoost = optionalBoolean(input.investmentBoost, "investmentBoost") ?? false;
  if (investmentBoost) {
    if (!depreciating) throw new ValidationError(`Investment Boost is only for assets depreciated by diminishing value or straight line, not ${TAX_DEPRECIATION_METHOD_LABELS[method].toLowerCase()}.`);
    if (!newAsset) throw new ValidationError("Investment Boost is only for new assets (or new to New Zealand): tick that it's new.");
    if (row.purchase_date < INVESTMENT_BOOST_FROM || availableOn < INVESTMENT_BOOST_FROM) {
      throw new ValidationError("Investment Boost is only for assets bought and first available for use on or after 22 May 2025.");
    }
  }
  if (method === "low_value") {
    if (cmp(dec(taxCost), LOW_VALUE_LIMIT) > 0) throw new ValidationError("A low-value write-off is only for assets costing 1,000.00 or less (excluding GST when registered).");
    if (row.purchase_date < LOW_VALUE_FROM) throw new ValidationError("The 1,000.00 low-value limit applies to assets bought from 17 March 2021.");
  }
  let openingYear: number | null = null;
  let openingAtv: string | null = null;
  if (input.openingIncomeYear != null && input.openingIncomeYear !== "") {
    const value = typeof input.openingIncomeYear === "string" ? Number(input.openingIncomeYear) : input.openingIncomeYear;
    if (typeof value !== "number" || !Number.isInteger(value) || !isSupportedIncomeYear(value)) throw new ValidationError("openingIncomeYear must be an income year from 2025.");
    openingYear = value;
    openingAtv = parseDecimalInput(input.openingAtv, "openingAtv", { maxScale: 2, allowZero: true });
    if (cmp(dec(openingAtv), dec(taxCost)) > 0) throw new ValidationError("The opening adjusted tax value can't be more than the tax cost.");
    if (incomeYearDates(openingYear, endMonth).end < availableOn) throw new ValidationError("The opening adjusted tax value is for an income year before the asset was available for use.");
    if (investmentBoost && openingYear === incomeYearOf(availableOn, endMonth)) {
      throw new ValidationError("With an opening adjusted tax value for the year it was bought, the Investment Boost is already in it: start from the next year, or leave the opening value out.");
    }
  }
  const version = versionOf(input.version);
  const current = row.version ?? 0;
  if (current !== version) throw new ConflictError(`Someone else changed ${label}'s tax details. Reload and try again.`);
  const before = toDetails(row);
  await tx.query(
    `insert into fixed_asset_tax_details (asset_id, method, rate, tax_cost, business_use_percent, available_on, new_asset, investment_boost,
                                          opening_income_year, opening_atv, updated_by_email)
     values ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6::date, $7, $8, $9, $10::numeric, $11)
     on conflict (asset_id) do update set method = excluded.method, rate = excluded.rate, tax_cost = excluded.tax_cost,
       business_use_percent = excluded.business_use_percent, available_on = excluded.available_on, new_asset = excluded.new_asset,
       investment_boost = excluded.investment_boost, opening_income_year = excluded.opening_income_year, opening_atv = excluded.opening_atv,
       version = fixed_asset_tax_details.version + 1, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [assetId, method, rate, taxCost, businessUse, availableOn, newAsset, investmentBoost, openingYear, openingAtv, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "income_tax.asset_details_set",
    entityType: "fixed_asset",
    entityId: assetId,
    details: {
      assetNumber: row.asset_number,
      from: before ? { method: before.method, rate: before.rate, taxCost: before.taxCost, businessUsePercent: before.businessUsePercent, availableOn: before.availableOn, investmentBoost: before.investmentBoost, openingIncomeYear: before.openingIncomeYear, openingAtv: before.openingAtv } : null,
      to: { method, rate, taxCost, businessUsePercent: businessUse, availableOn, newAsset, investmentBoost, openingIncomeYear: openingYear, openingAtv },
    },
  });
  const after = await tx.query<AssetRow>(`${ASSETS_SQL} where f.id = $1`, [assetId]);
  return toAsset(after.rows[0], incomeYearOf(availableOn, endMonth), endMonth);
}

/** How much of a posted amount counts for tax, by its account's treatment (ITX18). */
function factor(treatment: Treatment | undefined, percent: string | null): Decimal {
  switch (treatment) {
    case "not_deductible":
    case "not_taxable":
      return ZERO_DECIMAL;
    case "entertainment_50":
      return dec("0.5");
    case "business_use":
      return divide(dec(percent ?? "0"), dec("100"), 6);
    default:
      return dec("1");
  }
}

export type AssetAdjustments = {
  adjustments: Array<{ description: string; amount: Decimal }>;
  /** Assets whose book depreciation stands in for tax, as "FA-0001 Van". */
  notSetUp: string[];
  /** Depreciation accounts of assets with tax details that have budget amounts in the rest of the year. */
  budgetedDepreciationAccounts: string[];
};

/** The lines that swap book depreciation and disposal results for tax ones, for assets with tax details (ITX18). */
export async function assetAdjustments(
  tx: OrgTx,
  incomeYear: number,
  treatments: Map<string, { treatment: Treatment; businessUsePercent: string | null; code: string; name: string }>,
  budgetFrom: string | null,
): Promise<AssetAdjustments> {
  const endMonth = await financialYearEndMonth(tx);
  const { start, end } = incomeYearDates(incomeYear, endMonth);
  const assets = (await tx.query<AssetRow>(`${ASSETS_SQL} where f.status in ('registered', 'disposed') order by f.asset_number`)).rows;
  const withDetails = assets.filter((row) => row.d_method !== null);
  const notSetUp = assets.filter((row) => row.d_method === null && !(row.disposal_date !== null && row.disposal_date < start)).map((row) => `${row.asset_number} ${row.name}`);
  if (withDetails.length === 0) return { adjustments: [], notSetUp, budgetedDepreciationAccounts: [] };
  const ids = withDetails.map((row) => row.id);
  const contribution = (accountId: string, credit: Decimal, debit: Decimal) => {
    const treatment = treatments.get(accountId);
    return mul(sub(credit, debit), factor(treatment?.treatment, treatment?.businessUsePercent ?? null));
  };
  // Book depreciation the ledger shows in the year for these assets (runs and disposals dated in it).
  const lines = await tx.query<{ asset_id: string; amount: string }>(
    `select c.asset_id::text, sum(c.amount)::text as amount from (${COUNTING_LINES_SQL}) c
      where c.asset_id = any($1::bigint[]) and c.charged_on between $2::date and $3::date group by c.asset_id`,
    [ids, start, end],
  );
  const byId = new Map(withDetails.map((row) => [row.id, row]));
  let bookDepreciation = ZERO_DECIMAL;
  for (const line of lines.rows) bookDepreciation = sub(bookDepreciation, contribution(byId.get(line.asset_id)!.depreciation_account_id, ZERO_DECIMAL, dec(line.amount)));
  // Book gains and losses on disposals dated in the year.
  const disposals = await tx.query<{ gain_loss_account_id: string; capital_gain_account_id: string; depreciation_recovered: string; capital_gain: string; loss: string }>(
    `select gain_loss_account_id::text, capital_gain_account_id::text, depreciation_recovered::text, capital_gain::text, loss::text
       from fixed_asset_disposals where status = 'active' and asset_id = any($1::bigint[]) and disposal_date between $2::date and $3::date`,
    [ids, start, end],
  );
  let bookDisposals = ZERO_DECIMAL;
  for (const row of disposals.rows) {
    bookDisposals = add(bookDisposals, contribution(row.gain_loss_account_id, dec(row.depreciation_recovered), dec(row.loss)));
    bookDisposals = add(bookDisposals, contribution(row.capital_gain_account_id, dec(row.capital_gain), ZERO_DECIMAL));
  }
  let boost = ZERO_DECIMAL;
  let depreciation = ZERO_DECIMAL;
  let recovered = ZERO_DECIMAL;
  let loss = ZERO_DECIMAL;
  for (const row of withDetails) {
    const year = yearFor(row, toDetails(row), incomeYear, endMonth);
    if (!year) continue;
    boost = add(boost, dec(year.boostClaimed));
    depreciation = add(depreciation, dec(year.depreciationClaimed));
    recovered = add(recovered, dec(year.recovered));
    loss = add(loss, dec(year.loss));
  }
  const adjustments = [
    { description: "Book depreciation on assets with tax details, added back", amount: bookDepreciation },
    { description: "Book gains and losses on their disposal, reversed", amount: mul(bookDisposals, dec("-1")) },
    { description: "Investment Boost", amount: mul(boost, dec("-1")) },
    { description: "Tax depreciation", amount: mul(depreciation, dec("-1")) },
    { description: "Depreciation recovered (tax)", amount: recovered },
    { description: "Loss on disposal (tax)", amount: mul(loss, dec("-1")) },
  ].filter((entry) => !isZero(entry.amount));
  let budgetedDepreciationAccounts: string[] = [];
  if (budgetFrom) {
    const accounts = [...new Set(withDetails.map((row) => row.depreciation_account_id))];
    const budgeted = await tx.query<{ account_id: string }>(
      `select distinct a.account_id::text from budget_amounts a join budgets b on b.id = a.budget_id
        where b.is_overall and a.amount <> 0 and a.account_id = any($1::bigint[]) and a.month between $2::date and $3::date`,
      [accounts, budgetFrom, end],
    );
    budgetedDepreciationAccounts = budgeted.rows.map((entry) => {
      const account = treatments.get(entry.account_id);
      return account ? `${account.code} ${account.name}` : entry.account_id;
    });
  }
  return { adjustments, notSetUp, budgetedDepreciationAccounts };
}

export type TaxAssetTotals = {
  /** Book depreciation the ledger shows in the year on assets with tax details, before any account treatment. */
  bookDepreciation: Decimal;
  boostClaimed: Decimal;
  depreciationClaimed: Decimal;
  loss: Decimal;
  /** The business-use share of the cost of assets whose Investment Boost is claimed this year (IR10 box 60). */
  boostAssetValue: Decimal;
  /** The cost of register assets bought in the year (IR10 box 54). */
  additions: Decimal;
  /** Proceeds of register disposals in the year (IR10 box 55). */
  disposalProceeds: Decimal;
};

/** Register figures for the IR10's other information boxes (ITX23). */
export async function taxAssetTotals(tx: OrgTx, incomeYear: number): Promise<TaxAssetTotals> {
  const endMonth = await financialYearEndMonth(tx);
  const { start, end } = incomeYearDates(incomeYear, endMonth);
  const assets = (await tx.query<AssetRow>(`${ASSETS_SQL} where f.status in ('registered', 'disposed') order by f.asset_number`)).rows;
  const detailed = assets.filter((row) => row.d_method !== null);
  const book = detailed.length
    ? await tx.query<{ amount: string | null }>(
        `select sum(c.amount)::text as amount from (${COUNTING_LINES_SQL}) c where c.asset_id = any($1::bigint[]) and c.charged_on between $2::date and $3::date`,
        [detailed.map((row) => row.id), start, end],
      )
    : { rows: [{ amount: null }] };
  let boostClaimed = ZERO_DECIMAL;
  let depreciationClaimed = ZERO_DECIMAL;
  let loss = ZERO_DECIMAL;
  let boostAssetValue = ZERO_DECIMAL;
  for (const row of detailed) {
    const details = toDetails(row)!;
    const year = yearFor(row, details, incomeYear, endMonth);
    if (!year) continue;
    boostClaimed = add(boostClaimed, dec(year.boostClaimed));
    depreciationClaimed = add(depreciationClaimed, dec(year.depreciationClaimed));
    loss = add(loss, dec(year.loss));
    if (!isZero(dec(year.investmentBoost))) boostAssetValue = add(boostAssetValue, divide(mul(dec(details.taxCost), dec(details.businessUsePercent)), dec("100"), 2));
  }
  let additions = ZERO_DECIMAL;
  for (const row of assets) if (row.purchase_date >= start && row.purchase_date <= end) additions = add(additions, dec(row.cost));
  const disposals = await tx.query<{ proceeds: string | null }>(
    "select sum(proceeds)::text as proceeds from fixed_asset_disposals where status = 'active' and disposal_date between $1::date and $2::date",
    [start, end],
  );
  return {
    bookDepreciation: dec(book.rows[0].amount ?? "0"),
    boostClaimed,
    depreciationClaimed,
    loss,
    boostAssetValue,
    additions,
    disposalProceeds: dec(disposals.rows[0].proceeds ?? "0"),
  };
}
