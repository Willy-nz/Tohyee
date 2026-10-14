import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { addDays, financialYearEnd, financialYearStart } from "@/lib/financial-year";
import { add, dec, type Decimal, divide, isPositive, isZero, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { accountTotals, financialYearEndMonth, naturalAmount } from "@/lib/reports/financial";
import { requireOneOf, requireString } from "@/lib/validation";
import { requireFarming } from "./paddocks";

/*
 * Farm benchmarks (#259; examples FK1-FK4, decision 531). Expense accounts
 * are grouped as farm working expenses (FWE), and each year's physical
 * figures are entered, so the year's figures can be read per kg of milk
 * solids, per effective hectare, per peak cow and per stock unit, as farm
 * benchmarking does. FWE are only the accounts put in a group: depreciation,
 * interest, rent and tax aren't working expenses, so they're never grouped
 * unless someone chooses to. Gross farm revenue is the year's trading income
 * (revenue accounts). Nothing here posts.
 */

export const FWE_GROUPS = [
  { key: "wages", label: "Wages" },
  { key: "animal_health", label: "Animal health" },
  { key: "breeding", label: "Breeding and herd testing" },
  { key: "farm_dairy", label: "Farm dairy" },
  { key: "electricity", label: "Electricity" },
  { key: "feed", label: "Feed (supplements)" },
  { key: "grazing", label: "Grazing" },
  { key: "fertiliser", label: "Fertiliser, nitrogen and lime" },
  { key: "irrigation", label: "Irrigation" },
  { key: "regrassing", label: "Regrassing and cropping" },
  { key: "weed_pest", label: "Weed and pest" },
  { key: "vehicles", label: "Vehicles and fuel" },
  { key: "repairs", label: "Repairs and maintenance" },
  { key: "freight", label: "Freight" },
  { key: "administration", label: "Administration" },
  { key: "insurance", label: "Insurance" },
  { key: "rates", label: "Rates" },
  { key: "other", label: "Other working expenses" },
] as const;
export type FweGroup = (typeof FWE_GROUPS)[number]["key"];
const GROUP_KEYS = FWE_GROUPS.map((group) => group.key);

export type YearFigures = {
  yearEnd: string;
  /** As entered; null when not entered. */
  effectiveHa: string | null;
  peakCows: number | null;
  stockUnits: string | null;
  milkSolidsKg: string | null;
  /** The active paddocks' effective area today, offered when the year's isn't entered. */
  paddockHa: string | null;
};

/** An amount, and per kgMS, hectare, cow and stock unit (null when that figure isn't entered). */
export type PerUnit = { amount: string; perKgMs: string | null; perHa: string | null; perCow: string | null; perSu: string | null };

export type FarmBenchmarks = {
  /** The current financial year's end and the four before it, newest first, to choose from. */
  yearEnds: string[];
  yearStart: string;
  yearEnd: string;
  figures: YearFigures;
  grossFarmRevenue: PerUnit;
  groups: Array<{ key: FweGroup; label: string; accounts: Array<{ code: string; name: string; amount: string }> } & PerUnit>;
  workingExpenses: PerUnit;
  /** Gross farm revenue less farm working expenses. */
  operatingSurplus: PerUnit;
  /** Expense accounts with spending in the year that aren't in a group: they're left out of FWE. */
  ungrouped: Array<{ code: string; name: string; amount: string }>;
};

function yearEndOf(input: unknown, yearEndMonth: number): string {
  const date = parseIsoDate(input, "The year end");
  if (financialYearEnd(date, yearEndMonth) !== date) throw new ValidationError("That isn't a financial year end.");
  return date;
}

export async function getYearFigures(tx: OrgTx, yearEndInput: unknown): Promise<YearFigures> {
  await requireFarming(tx);
  const yearEnd = yearEndOf(yearEndInput, await financialYearEndMonth(tx));
  const row = (
    await tx.query<{ effective_ha: string | null; peak_cows: number | null; stock_units: string | null; milk_solids_kg: string | null }>(
      "select effective_ha::text, peak_cows, stock_units::text, milk_solids_kg::text from farm_year_figures where year_end = $1",
      [yearEnd],
    )
  ).rows[0];
  const paddocks = await tx.query<{ ha: string | null }>(
    "select sum(p.effective_ha)::text as ha from paddocks p join farms f on f.id = p.farm_id where p.status = 'active' and f.is_active",
  );
  return {
    yearEnd,
    effectiveHa: row?.effective_ha ?? null,
    peakCows: row?.peak_cows ?? null,
    stockUnits: row?.stock_units ?? null,
    milkSolidsKg: row?.milk_solids_kg ?? null,
    paddockHa: paddocks.rows[0]?.ha ? toFixedString(dec(paddocks.rows[0].ha), 2) : null,
  };
}

/** Saves a year's physical figures (FK2); an empty value clears it. */
export async function setYearFigures(
  tx: OrgTx,
  input: { yearEnd: unknown; effectiveHa?: unknown; peakCows?: unknown; stockUnits?: unknown; milkSolidsKg?: unknown },
): Promise<YearFigures> {
  await requireFarming(tx);
  const yearEnd = yearEndOf(input.yearEnd, await financialYearEndMonth(tx));
  const blank = (value: unknown) => value === undefined || value === null || value === "";
  const decimal = (value: unknown, label: string, scale: number) => (blank(value) ? null : parseDecimalInput(value, label, { maxScale: scale }));
  const effectiveHa = decimal(input.effectiveHa, "Effective hectares", 2);
  const stockUnits = decimal(input.stockUnits, "Stock units", 1);
  const milkSolidsKg = decimal(input.milkSolidsKg, "Milk solids (kg)", 1);
  let peakCows: number | null = null;
  if (!blank(input.peakCows)) {
    peakCows = Number(input.peakCows);
    if (!Number.isInteger(peakCows) || peakCows <= 0 || peakCows > 100000) throw new ValidationError("Peak cows milked must be a whole number above 0.");
  }
  await tx.query(
    `insert into farm_year_figures (year_end, effective_ha, peak_cows, stock_units, milk_solids_kg, updated_by_email)
     values ($1, $2::numeric, $3, $4::numeric, $5::numeric, $6)
     on conflict (year_end) do update set effective_ha = excluded.effective_ha, peak_cows = excluded.peak_cows, stock_units = excluded.stock_units,
       milk_solids_kg = excluded.milk_solids_kg, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [yearEnd, effectiveHa, peakCows, stockUnits, milkSolidsKg, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "farming.year_figures_saved",
    entityType: "organisation",
    entityId: tx.organisationId,
    details: { yearEnd, effectiveHa, peakCows, stockUnits, milkSolidsKg },
  });
  return getYearFigures(tx, yearEnd);
}

export type ExpenseGrouping = Array<{ code: string; name: string; group: FweGroup | null }>;

/** Every active expense account and its working-expense group, if it has one. */
export async function listExpenseGroups(tx: OrgTx): Promise<ExpenseGrouping> {
  await requireFarming(tx);
  const rows = await tx.query<{ code: string; name: string; group_key: FweGroup | null }>(
    `select a.code, a.name, g.group_key from accounts a left join farm_expense_groups g on g.account_id = a.id
      where a.account_class = 'expense' and (a.is_active or g.account_id is not null) order by a.code`,
  );
  return rows.rows.map((row) => ({ code: row.code, name: row.name, group: row.group_key }));
}

/** Puts an expense account in a working-expense group, or takes it out (`group` null) (FK1). */
export async function setExpenseGroup(tx: OrgTx, input: { accountCode: unknown; group: unknown }): Promise<ExpenseGrouping> {
  await requireFarming(tx);
  const code = requireString(input.accountCode, "The account", { maxLength: 20 });
  const account = (await tx.query<{ id: string; account_class: string }>("select id::text, account_class from accounts where lower(code) = lower($1)", [code])).rows[0];
  if (!account) throw new ValidationError(`There's no account ${code}.`);
  if (account.account_class !== "expense") throw new ValidationError(`Account ${code} isn't an expense account, so it can't be a farm working expense.`);
  if (input.group === null || input.group === "" || input.group === undefined) {
    await tx.query("delete from farm_expense_groups where account_id = $1", [account.id]);
  } else {
    const group = requireOneOf(input.group, "group", GROUP_KEYS);
    await tx.query(
      `insert into farm_expense_groups (account_id, group_key, updated_by_email) values ($1, $2, $3)
       on conflict (account_id) do update set group_key = excluded.group_key, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [account.id, group, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: "farming.expense_group_set", entityType: "account", entityId: account.id, details: { group: input.group ?? null } });
  return listExpenseGroups(tx);
}

/** Per kgMS, ha, cow and su, rounded to 2 places; null where a figure isn't entered (FK3). */
function perUnit(amount: Decimal, figures: YearFigures): PerUnit {
  const per = (figure: string | number | null) => (figure === null || !isPositive(dec(String(figure))) ? null : toFixedString(divide(amount, dec(String(figure)), 2), 2));
  return {
    amount: toFixedString(amount, 2),
    perKgMs: per(figures.milkSolidsKg),
    perHa: per(figures.effectiveHa),
    perCow: per(figures.peakCows),
    perSu: per(figures.stockUnits),
  };
}

/** The year's farm working expenses by group, gross farm revenue and operating surplus, in total and per unit (FK1-FK4). */
export async function farmBenchmarks(tx: OrgTx, input: { yearEnd: unknown }): Promise<FarmBenchmarks> {
  await requireFarming(tx);
  const yearEndMonth = await financialYearEndMonth(tx);
  const current = financialYearEnd(todayIsoDate(), yearEndMonth);
  const yearEnd = input.yearEnd === undefined || input.yearEnd === null || input.yearEnd === "" ? current : yearEndOf(input.yearEnd, yearEndMonth);
  const yearStart = financialYearStart(yearEnd, yearEndMonth);
  const yearEnds = [current];
  while (yearEnds.length < 5) yearEnds.push(financialYearEnd(addDays(financialYearStart(yearEnds[yearEnds.length - 1], yearEndMonth), -1), yearEndMonth));
  const figures = await getYearFigures(tx, yearEnd);
  const rows = await accountTotals(tx, yearStart, yearEnd);
  const grouping = new Map(
    (await tx.query<{ account_id: string; group_key: FweGroup }>("select account_id::text, group_key from farm_expense_groups")).rows.map((row) => [row.account_id, row.group_key]),
  );
  let revenue = ZERO_DECIMAL;
  const byGroup = new Map<FweGroup, { total: Decimal; accounts: Array<{ code: string; name: string; amount: string }> }>();
  const ungrouped: FarmBenchmarks["ungrouped"] = [];
  for (const row of rows) {
    const amount = naturalAmount(row);
    if (row.account_type === "revenue") revenue = add(revenue, amount);
    if (row.account_class !== "expense" || isZero(amount)) continue;
    const group = grouping.get(row.id);
    if (!group) {
      ungrouped.push({ code: row.code, name: row.name, amount: toFixedString(amount, 2) });
      continue;
    }
    const entry = byGroup.get(group) ?? { total: ZERO_DECIMAL, accounts: [] };
    entry.total = add(entry.total, amount);
    entry.accounts.push({ code: row.code, name: row.name, amount: toFixedString(amount, 2) });
    byGroup.set(group, entry);
  }
  let fwe = ZERO_DECIMAL;
  const groups: FarmBenchmarks["groups"] = [];
  for (const group of FWE_GROUPS) {
    const entry = byGroup.get(group.key);
    if (!entry) continue;
    fwe = add(fwe, entry.total);
    groups.push({ key: group.key, label: group.label, accounts: entry.accounts, ...perUnit(entry.total, figures) });
  }
  return {
    yearEnds,
    yearStart,
    yearEnd,
    figures,
    grossFarmRevenue: perUnit(revenue, figures),
    groups,
    workingExpenses: perUnit(fwe, figures),
    operatingSurplus: perUnit(sub(revenue, fwe), figures),
    ungrouped,
  };
}
