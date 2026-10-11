import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { add, cmp, dec, type Decimal, isNegative, isZero, mul, mulDiv, neg, parseDecimalInput, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalSource, optionalString, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";
import { classesOf, classKey, className, findClass, KIND_NAMES, LIVESTOCK_KINDS, type LivestockKind } from "./classes";
import { getLivestockSettings, requireLivestock, requireYearEnd, yearFacts, type YearFacts } from "./movements";

/*
 * The livestock year-end valuation (#221 stage 3; examples LV4-LV12,
 * decisions 503 and 505). Herd scheme: opening stock revalued to this
 * year's NAMV (non-taxable) and closing stock at NAMV; NSC: rising one-year
 * stock at this year's NSC, last year's rising one-years joining the mature
 * group at their value plus this year's rising two-year NSC, and the mature
 * group averaged. An accountant (admin) approves; that posts one journal.
 */

export type Method = "herd_scheme" | "nsc";
export const METHOD_NAMES: Readonly<Record<Method, string>> = { herd_scheme: "Herd scheme", nsc: "National standard cost" };

export type ClassWorking = {
  classCode: string;
  className: string;
  openingHead: number;
  openingValue: string;
  /** Herd scheme: this year's NAMV; NSC rising one-year: this year's NSC. */
  rate: string | null;
  openingRevalued: string;
  closingHead: number;
  closingValue: string;
};

export type NscWorking = {
  risingOneRate: string;
  risingTwoRate: string;
  matureOpeningHead: number;
  matureOpeningValue: string;
  matureOut: number;
  survivorsValue: string;
  intakeHead: number;
  intakeValue: string;
  purchasedHead: number;
  purchasedCost: string;
  matureClosingHead: number;
  matureClosingValue: string;
  matureAverage: string;
};

export type KindWorking = {
  kind: LivestockKind;
  kindName: string;
  method: Method;
  classes: ClassWorking[];
  nsc: NscWorking | null;
  openingValue: string;
  revaluation: string;
  openingRevalued: string;
  closingValue: string;
  valueChange: string;
  sales: string;
  purchases: string;
  taxableProfit: string;
};

export type Workings = {
  yearStart: string;
  yearEnd: string;
  incomeYear: number;
  kinds: KindWorking[];
  totals: {
    openingValue: string;
    revaluation: string;
    openingRevalued: string;
    closingValue: string;
    valueChange: string;
    sales: string;
    purchases: string;
    taxableProfit: string;
  };
};

export type JournalPreviewLine = { accountCode: string; accountName: string; description: string; debit: string; credit: string };

export type ValuationPreview = {
  workings: Workings;
  revaluationTarget: "profit_and_loss" | "reserve";
  journal: JournalPreviewLine[];
  /** What stops approval; empty when it can be approved. */
  problems: string[];
  /** The asset account's balance at the year end before this valuation, which should equal the opening value. */
  ledgerOpening: string | null;
  approved: Valuation | null;
};

export type Valuation = {
  id: string;
  yearEnd: string;
  incomeYear: number;
  status: "approved" | "replaced";
  revaluationTarget: "profit_and_loss" | "reserve";
  workings: Workings;
  journalId: string | null;
  approvedByEmail: string;
  approvedAt: string;
  replaceReason: string | null;
  reversalJournalId: string | null;
  replacedByEmail: string | null;
  replacedAt: string | null;
};

const money = (value: Decimal) => toFixedString(value, 2);

/**
 * The IRD income year a year end belongs to (2026 = the 2025-26 income year,
 * ending 31 March 2026). A balance date from April to September is a late
 * balance date and belongs to the income year ending the 31 March before it
 * (Kōwhai's 31 May 2026 and Tussock's 30 June 2026 are both 2026, as in LV4
 * and LV10); October to March belongs to the next 31 March.
 */
export function incomeYearOf(yearEnd: string): number {
  const year = Number(yearEnd.slice(0, 4));
  const month = Number(yearEnd.slice(5, 7));
  return month >= 10 ? year + 1 : year;
}

// Rates -----------------------------------------------------------------------

export type Rate = { id: string; incomeYear: number; rateKind: "namv" | "nsc"; kind: LivestockKind; category: string; categoryName: string; amount: string; source: string; enteredByEmail: string };

const NSC_CATEGORIES = { rising_1: "Rising 1 year", rising_2: "Rising 2 year", purchased_bobby_calves: "Purchased bobby calves" } as const;

export async function listRates(tx: OrgTx, input: { incomeYear?: unknown } = {}): Promise<Rate[]> {
  const year = input.incomeYear === undefined || input.incomeYear === null || input.incomeYear === "" ? null : Number(parseDecimalInput(input.incomeYear, "incomeYear", { maxScale: 0 }));
  const rows = await tx.query<{ id: string; income_year: number; rate_kind: "namv" | "nsc"; kind: LivestockKind; category: string; amount: string; source: string; entered_by_email: string }>(
    `select id::text, income_year, rate_kind, kind, category, amount::text, source, entered_by_email from livestock_rates
      where ($1::integer is null or income_year = $1) order by income_year desc, rate_kind, kind, livestock_rates.id`,
    [year],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    incomeYear: row.income_year,
    rateKind: row.rate_kind,
    kind: row.kind,
    category: row.category,
    categoryName: row.rate_kind === "namv" ? className(row.kind, row.category) : (NSC_CATEGORIES[row.category as keyof typeof NSC_CATEGORIES] ?? row.category),
    amount: row.amount,
    source: row.source,
    enteredByEmail: row.entered_by_email,
  }));
}

/**
 * Adds or corrects one rate, with where it came from. A year's rates can't
 * change once a valuation using them is approved (#221: a finalised
 * valuation never changes when new rates arrive).
 */
export async function setRate(tx: OrgTx, input: { incomeYear: unknown; rateKind: unknown; kind: unknown; category: unknown; amount: unknown; source: unknown }): Promise<Rate> {
  await requireLivestock(tx);
  const incomeYear = Number(parseDecimalInput(input.incomeYear, "Income year", { maxScale: 0 }));
  if (incomeYear < 2000 || incomeYear > 2100) throw new ValidationError("The income year must be between 2000 and 2100.");
  const rateKind = requireOneOf(input.rateKind, "rateKind", ["namv", "nsc"] as const);
  const kind = requireOneOf(input.kind, "kind", LIVESTOCK_KINDS);
  const category = requireString(input.category, "category", { maxLength: 50 });
  if (rateKind === "namv" && !findClass(kind, category)) throw new ValidationError(`${KIND_NAMES[kind]} has no class "${category}".`);
  if (rateKind === "nsc" && !(category in NSC_CATEGORIES)) throw new ValidationError("An NSC category is rising_1, rising_2 or purchased_bobby_calves.");
  const amount = parseDecimalInput(input.amount, "Amount", { maxScale: 2, allowZero: true });
  const source = requireString(input.source, "Where the rate came from", { maxLength: 500 });
  const used = await tx.query("select 1 from livestock_valuations where income_year = $1 and status = 'approved'", [incomeYear]);
  if (used.rowCount) throw new ConflictError(`A valuation using the ${incomeYear} rates is approved. Replace it before changing them.`);
  const row = await tx.query<{ id: string }>(
    `insert into livestock_rates (income_year, rate_kind, kind, category, amount, source, entered_by_email) values ($1, $2, $3, $4, $5::numeric, $6, $7)
     on conflict (income_year, rate_kind, kind, category) do update set amount = excluded.amount, source = excluded.source,
       entered_by_email = excluded.entered_by_email, entered_at = now()
     returning id::text`,
    [incomeYear, rateKind, kind, category, amount, source, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "livestock.rate_set", entityType: "livestock_rate", entityId: row.rows[0].id, details: { incomeYear, rateKind, kind, category, amount, source } });
  return (await listRates(tx, { incomeYear })).find((rate) => rate.id === row.rows[0].id)!;
}

// Elections -------------------------------------------------------------------

export type Election = { id: string; kind: LivestockKind; kindName: string; method: Method; methodName: string; fromIncomeYear: number; note: string | null; createdByEmail: string; createdAt: string };

export async function listElections(tx: OrgTx): Promise<Election[]> {
  const rows = await tx.query<{ id: string; kind: LivestockKind; method: Method; from_income_year: number; note: string | null; created_by_email: string; created_at: string }>(
    "select id::text, kind, method, from_income_year, note, created_by_email, created_at::text from livestock_elections order by kind, from_income_year desc",
  );
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    kindName: KIND_NAMES[row.kind],
    method: row.method,
    methodName: METHOD_NAMES[row.method],
    fromIncomeYear: row.from_income_year,
    note: row.note,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  }));
}

/**
 * Records the farm's method for a kind of livestock from an income year
 * (decision 503). Attach the evidence as files on the election. Recording
 * it files nothing with IRD.
 */
export async function recordElection(tx: OrgTx, input: { kind: unknown; method: unknown; fromIncomeYear: unknown; note?: unknown }): Promise<Election> {
  await requireLivestock(tx);
  const kind = requireOneOf(input.kind, "kind", LIVESTOCK_KINDS);
  const method = requireOneOf(input.method, "method", ["herd_scheme", "nsc"] as const);
  const fromIncomeYear = Number(parseDecimalInput(input.fromIncomeYear, "From income year", { maxScale: 0 }));
  if (fromIncomeYear < 2000 || fromIncomeYear > 2100) throw new ValidationError("The income year must be between 2000 and 2100.");
  const note = optionalString(input.note, "note", { maxLength: 1000 });
  const later = await tx.query("select 1 from livestock_valuations where income_year >= $1 and status = 'approved'", [fromIncomeYear]);
  if (later.rowCount) throw new ConflictError(`A valuation for the ${fromIncomeYear} income year or later is approved. Replace it before changing elections.`);
  try {
    const row = await tx.query<{ id: string }>(
      "insert into livestock_elections (kind, method, from_income_year, note, created_by_user_id, created_by_email) values ($1, $2, $3, $4, $5, $6) returning id::text",
      [kind, method, fromIncomeYear, note, tx.actor.userId, tx.actor.email],
    );
    await writeAuditEvent(tx, { eventType: "livestock.election_recorded", entityType: "livestock_election", entityId: row.rows[0].id, details: { kind, method, fromIncomeYear } });
    return (await listElections(tx)).find((entry) => entry.id === row.rows[0].id)!;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConflictError(`${KIND_NAMES[kind]} already has an election from ${fromIncomeYear}.`);
    throw error;
  }
}

// Working it out ----------------------------------------------------------------

async function ratesFor(tx: OrgTx, incomeYear: number): Promise<Map<string, string>> {
  const rows = await tx.query<{ rate_kind: string; kind: string; category: string; amount: string }>(
    "select rate_kind, kind, category, amount::text from livestock_rates where income_year = $1",
    [incomeYear],
  );
  return new Map(rows.rows.map((row) => [`${row.rate_kind}.${row.kind}.${row.category}`, row.amount]));
}

async function electionFor(tx: OrgTx, kind: string, incomeYear: number): Promise<Method | null> {
  const row = await tx.query<{ method: Method }>(
    "select method from livestock_elections where kind = $1 and from_income_year <= $2 order by from_income_year desc limit 1",
    [kind, incomeYear],
  );
  return row.rows[0]?.method ?? null;
}

async function valuationRow(tx: OrgTx, where: string, params: unknown[]): Promise<Valuation | null> {
  const rows = await tx.query<{
    id: string;
    year_end: string;
    income_year: number;
    status: "approved" | "replaced";
    revaluation_target: "profit_and_loss" | "reserve";
    workings: Workings;
    journal_id: string | null;
    approved_by_email: string;
    approved_at: string;
    replace_reason: string | null;
    reversal_journal_id: string | null;
    replaced_by_email: string | null;
    replaced_at: string | null;
  }>(
    `select id::text, year_end::text, income_year, status, revaluation_target, workings, journal_id::text, approved_by_email, approved_at::text,
            replace_reason, reversal_journal_id::text, replaced_by_email, replaced_at::text
       from livestock_valuations where ${where} order by livestock_valuations.id desc limit 1`,
    params,
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    yearEnd: row.year_end,
    incomeYear: row.income_year,
    status: row.status,
    revaluationTarget: row.revaluation_target,
    workings: row.workings,
    journalId: row.journal_id,
    approvedByEmail: row.approved_by_email,
    approvedAt: row.approved_at,
    replaceReason: row.replace_reason,
    reversalJournalId: row.reversal_journal_id,
    replacedByEmail: row.replaced_by_email,
    replacedAt: row.replaced_at,
  };
}

/** Opening values by class: the first year's from the workpaper, later years' from last year's approved valuation. */
async function openingValues(tx: OrgTx, firstYearStart: string, yearStart: string, problems: string[]): Promise<{ values: Map<string, string>; previousMethods: Map<string, Method> }> {
  const values = new Map<string, string>();
  const previousMethods = new Map<string, Method>();
  if (yearStart === firstYearStart) {
    const rows = await tx.query<{ kind: string; class_code: string; value: string }>("select kind, class_code, value::text from livestock_openings");
    for (const row of rows.rows) values.set(classKey(row.kind, row.class_code), row.value);
    return { values, previousMethods };
  }
  const previous = await valuationRow(tx, "year_end = $1 and status = 'approved'", [addDays(yearStart, -1)]);
  if (!previous) {
    problems.push(`Approve the valuation for the year to ${addDays(yearStart, -1)} first: this year opens with its closing values.`);
    return { values, previousMethods };
  }
  for (const kind of previous.workings.kinds) {
    previousMethods.set(kind.kind, kind.method);
    for (const entry of kind.classes) values.set(classKey(kind.kind, entry.classCode), entry.closingValue);
  }
  return { values, previousMethods };
}

function movementAmount(movement: YearFacts["movements"][number]): string | null {
  return movement.amount ?? movement.linkedNetAmount;
}

/** Works out the valuation for a year end, with anything that stops approval (LV4-LV11). */
export async function workOut(tx: OrgTx, yearEnd: string): Promise<{ workings: Workings; problems: string[]; openingTotal: string; openingKnown: boolean }> {
  const settings = await requireLivestock(tx);
  const facts = await yearFacts(tx, yearEnd);
  const incomeYear = incomeYearOf(yearEnd);
  const problems: string[] = [];
  const rates = await ratesFor(tx, incomeYear);
  const before = problems.length;
  const { values: opening, previousMethods } = await openingValues(tx, settings.firstYearStart, facts.yearStart, problems);
  const missingPrevious = problems.length > before;

  for (const step of facts.ageing.needsSplit) {
    problems.push(`Say how many ${step.className.toLowerCase()} (${step.head}) turned rising five at the start of the year.`);
  }
  for (const entry of facts.unexplained) {
    problems.push(`${entry.className}: ${entry.counted} counted but ${entry.expected} expected (${Math.abs(entry.difference)} not explained, LV2).`);
  }

  const kinds: KindWorking[] = [];
  for (const kind of LIVESTOCK_KINDS) {
    const classes = classesOf(kind);
    const headOf = (map: Map<string, number>, code: string) => map.get(classKey(kind, code)) ?? 0;
    const kindMovements = facts.movements.filter((movement) => movement.kind === kind);
    const hasStock = classes.some((entry) => headOf(facts.opening, entry.code) !== 0 || headOf(facts.closing, entry.code) !== 0) || kindMovements.length > 0;
    if (!hasStock) continue;
    const kindName = KIND_NAMES[kind];
    const method = await electionFor(tx, kind, incomeYear);
    if (!method) {
      problems.push(`${kindName}: record which valuation method the farm uses (its election) for the ${incomeYear} income year.`);
      continue;
    }
    const previousMethod = previousMethods.get(kind);
    if (previousMethod && previousMethod !== method) {
      problems.push(`${kindName}: changing from ${METHOD_NAMES[previousMethod]} to ${METHOD_NAMES[method]} isn't supported yet.`);
      continue;
    }
    for (const entry of classes) {
      if (entry.maleBreeding && (headOf(facts.opening, entry.code) > 0 || headOf(facts.closing, entry.code) > 0)) {
        problems.push(`${kindName}: ${entry.name.toLowerCase()} have their own rules, which aren't supported yet.`);
      }
    }
    let sales = ZERO_DECIMAL;
    let purchases = ZERO_DECIMAL;
    for (const movement of kindMovements) {
      if (movement.movementType !== "sale" && movement.movementType !== "purchase") continue;
      const amount = movementAmount(movement);
      if (amount === null) {
        problems.push(`${kindName}: give the amount (excluding GST) of the ${movement.movementType} of ${movement.head} ${className(kind, movement.classCode).toLowerCase()} on ${movement.movementDate}.`);
        continue;
      }
      if (movement.movementType === "sale") sales = add(sales, dec(amount));
      else purchases = add(purchases, dec(amount));
    }
    const openingOf = (code: string) => opening.get(classKey(kind, code)) ?? "0.00";
    const working = method === "herd_scheme" ? herdScheme(kind, facts, rates, incomeYear, openingOf, problems) : nsc(kind, facts, rates, incomeYear, openingOf, problems);
    if (!working) continue;
    const openingValue = sum(working.classes.map((entry) => dec(entry.openingValue)));
    const openingRevalued = sum(working.classes.map((entry) => dec(entry.openingRevalued)));
    const closingValue = sum(working.classes.map((entry) => dec(entry.closingValue)));
    const valueChange = sub(closingValue, openingRevalued);
    kinds.push({
      kind,
      kindName,
      method,
      classes: working.classes,
      nsc: working.nsc,
      openingValue: money(openingValue),
      revaluation: money(sub(openingRevalued, openingValue)),
      openingRevalued: money(openingRevalued),
      closingValue: money(closingValue),
      valueChange: money(valueChange),
      sales: money(sales),
      purchases: money(purchases),
      taxableProfit: money(add(sub(sales, purchases), valueChange)),
    });
  }
  const total = (field: keyof Workings["totals"]) => money(sum(kinds.map((entry) => dec(entry[field]))));
  return {
    workings: {
      yearStart: facts.yearStart,
      yearEnd,
      incomeYear,
      kinds,
      totals: {
        openingValue: total("openingValue"),
        revaluation: total("revaluation"),
        openingRevalued: total("openingRevalued"),
        closingValue: total("closingValue"),
        valueChange: total("valueChange"),
        sales: total("sales"),
        purchases: total("purchases"),
        taxableProfit: total("taxableProfit"),
      },
    },
    problems,
    // Every class's opening value, whether or not its kind could be worked out, for the ledger check.
    openingTotal: money(sum([...opening.values()].map((value) => dec(value)))),
    openingKnown: !missingPrevious,
  };
}

type KindResult = { classes: ClassWorking[]; nsc: NscWorking | null } | null;

/** Herd scheme (LV4, LV5, LV10): opening head revalued at this year's NAMV, closing head at NAMV, by class. */
function herdScheme(
  kind: LivestockKind,
  facts: YearFacts,
  rates: Map<string, string>,
  incomeYear: number,
  openingOf: (code: string) => string,
  problems: string[],
): KindResult {
  const classes: ClassWorking[] = [];
  let missing = false;
  for (const entry of classesOf(kind)) {
    const openingHead = facts.opening.get(classKey(kind, entry.code)) ?? 0;
    const closingHead = facts.closing.get(classKey(kind, entry.code)) ?? 0;
    const openingValue = openingOf(entry.code);
    if (openingHead === 0 && closingHead === 0 && isZero(dec(openingValue))) continue;
    const rate = rates.get(`namv.${kind}.${entry.code}`);
    if (rate === undefined) {
      problems.push(`${KIND_NAMES[kind]}: there's no ${incomeYear} national average market value for ${entry.name.toLowerCase()}. Add it from IRD's determination.`);
      missing = true;
      continue;
    }
    classes.push({
      classCode: entry.code,
      className: entry.name,
      openingHead,
      openingValue: money(dec(openingValue)),
      rate,
      openingRevalued: money(mul(dec(String(openingHead)), dec(rate))),
      closingHead,
      closingValue: money(mul(dec(String(closingHead)), dec(rate))),
    });
  }
  return missing ? null : { classes, nsc: null };
}

/**
 * National standard cost, averaging the mature group (LV6, LV11; decision
 * 503: the mature group is rising two and older). Rising one-year stock is
 * at this year's NSC; last year's rising one-years join the mature group at
 * their value plus this year's rising two-year NSC; mature stock that left is
 * taken out at the opening average, and purchases join at cost.
 */
function nsc(
  kind: LivestockKind,
  facts: YearFacts,
  rates: Map<string, string>,
  incomeYear: number,
  openingOf: (code: string) => string,
  problems: string[],
): KindResult {
  const kindName = KIND_NAMES[kind];
  const before = problems.length;
  const risingOneRate = rates.get(`nsc.${kind}.rising_1`);
  const risingTwoRate = rates.get(`nsc.${kind}.rising_2`);
  if (risingOneRate === undefined || risingTwoRate === undefined) {
    problems.push(`${kindName}: there are no ${incomeYear} national standard costs (rising 1 and rising 2 year). Add them from IRD's determination.`);
    return null;
  }
  const classes = classesOf(kind);
  const groupOf = (code: string) => findClass(kind, code)?.nsc ?? "unsupported";
  const headOf = (map: Map<string, number>, code: string) => map.get(classKey(kind, code)) ?? 0;
  for (const entry of classes) {
    if (entry.nsc === "unsupported" && !entry.maleBreeding && (headOf(facts.opening, entry.code) > 0 || headOf(facts.closing, entry.code) > 0)) {
      problems.push(`${kindName}: ${entry.name.toLowerCase()} under national standard cost aren't supported yet.`);
    }
  }
  let matureOut = 0;
  let purchasedHead = 0;
  let purchasedCost = ZERO_DECIMAL;
  for (const movement of facts.movements.filter((entry) => entry.kind === kind)) {
    const group = groupOf(movement.classCode);
    const label = `${movement.head} ${className(kind, movement.classCode).toLowerCase()} on ${movement.movementDate}`;
    if (movement.movementType === "found") problems.push(`${kindName}: found stock (${label}) under national standard cost isn't supported yet.`);
    if (movement.movementType === "purchase" && group === "rising_1") {
      problems.push(`${kindName}: bought young stock (${label}) under national standard cost isn't supported yet.`);
    }
    if (movement.movementType === "reclass" && groupOf(movement.toClassCode ?? "") !== group) {
      problems.push(`${kindName}: a class change between young and mature stock (${label}) isn't supported yet.`);
    }
    if (group !== "mature") continue;
    if (movement.movementType === "sale" || movement.movementType === "death" || movement.movementType === "missing") matureOut += movement.head;
    if (movement.movementType === "purchase") {
      purchasedHead += movement.head;
      const amount = movementAmount(movement);
      if (amount !== null) purchasedCost = add(purchasedCost, dec(amount));
    }
  }
  const working: ClassWorking[] = [];
  let matureOpeningHead = 0;
  let matureOpeningValue = ZERO_DECIMAL;
  for (const entry of classes) {
    if (entry.nsc !== "mature") continue;
    matureOpeningHead += headOf(facts.opening, entry.code);
    matureOpeningValue = add(matureOpeningValue, dec(openingOf(entry.code)));
  }
  let intakeHead = 0;
  let intakeValue = ZERO_DECIMAL;
  for (const step of facts.ageing.steps.filter((entry) => entry.kind === kind)) {
    if (groupOf(step.classCode) !== "rising_1") continue;
    if (groupOf(step.toClassCode) !== "mature") {
      problems.push(`${kindName}: ${step.className.toLowerCase()} turn ${step.toClassName.toLowerCase()}, which national standard cost doesn't support yet.`);
      continue;
    }
    // Ageing moves every head on hand at the end of last year, so its value is the class's whole opening value.
    intakeHead += step.head;
    intakeValue = add(intakeValue, add(dec(openingOf(step.classCode)), mul(dec(String(step.head)), dec(risingTwoRate))));
  }
  if (matureOut > matureOpeningHead) {
    problems.push(`${kindName}: more mature stock left (${matureOut}) than was on hand at the start of the year (${matureOpeningHead}), which isn't supported yet.`);
  }
  if (problems.length > before) return null;
  const survivorsValue = matureOpeningHead === 0 ? ZERO_DECIMAL : mulDiv(matureOpeningValue, dec(String(matureOpeningHead - matureOut)), dec(String(matureOpeningHead)), 2);
  const matureClosingValue = add(add(survivorsValue, intakeValue), purchasedCost);
  const matureClosingHead = classes.filter((entry) => entry.nsc === "mature").reduce((total, entry) => total + headOf(facts.closing, entry.code), 0);
  if (matureClosingHead !== matureOpeningHead - matureOut + intakeHead + purchasedHead) {
    problems.push(`${kindName}: the mature group's head doesn't follow from its movements, so national standard cost can't value it.`);
    return null;
  }
  // The mature group's value is shared across its classes by head (the last class takes any rounding), so next year opens with it.
  const matureClasses = classes.filter((entry) => entry.nsc === "mature" && (headOf(facts.opening, entry.code) > 0 || headOf(facts.closing, entry.code) > 0 || !isZero(dec(openingOf(entry.code)))));
  let allocated = ZERO_DECIMAL;
  const withHead = matureClasses.filter((entry) => headOf(facts.closing, entry.code) > 0);
  for (const entry of classes) {
    const openingHead = headOf(facts.opening, entry.code);
    const closingHead = headOf(facts.closing, entry.code);
    const openingValue = dec(openingOf(entry.code));
    if (entry.nsc === "rising_1") {
      if (openingHead === 0 && closingHead === 0 && isZero(openingValue)) continue;
      working.push({
        classCode: entry.code,
        className: entry.name,
        openingHead,
        openingValue: money(openingValue),
        rate: risingOneRate,
        openingRevalued: money(openingValue),
        closingHead,
        closingValue: money(mul(dec(String(closingHead)), dec(risingOneRate))),
      });
    } else if (entry.nsc === "mature" && matureClasses.includes(entry)) {
      let closingValue = ZERO_DECIMAL;
      if (closingHead > 0) {
        const last = withHead[withHead.length - 1] === entry;
        closingValue = last ? sub(matureClosingValue, allocated) : mulDiv(matureClosingValue, dec(String(closingHead)), dec(String(matureClosingHead)), 2);
        allocated = add(allocated, closingValue);
      }
      working.push({
        classCode: entry.code,
        className: entry.name,
        openingHead,
        openingValue: money(openingValue),
        rate: null,
        openingRevalued: money(openingValue),
        closingHead,
        closingValue: money(closingValue),
      });
    }
  }
  return {
    classes: working,
    nsc: {
      risingOneRate,
      risingTwoRate,
      matureOpeningHead,
      matureOpeningValue: money(matureOpeningValue),
      matureOut,
      survivorsValue: money(survivorsValue),
      intakeHead,
      intakeValue: money(intakeValue),
      purchasedHead,
      purchasedCost: money(purchasedCost),
      matureClosingHead,
      matureClosingValue: money(matureClosingValue),
      matureAverage: matureClosingHead === 0 ? "0.00" : money(mulDiv(matureClosingValue, dec("1"), dec(String(matureClosingHead)), 2)),
    },
  };
}

// Posting -------------------------------------------------------------------------

type AccountIds = { asset: AccountRef; valueChange: AccountRef; revaluation: AccountRef };
type AccountRef = { code: string; name: string };

async function postingAccounts(tx: OrgTx, target: "profit_and_loss" | "reserve", problems: string[]): Promise<AccountIds | null> {
  const settings = await getLivestockSettings(tx);
  const revaluation = target === "reserve" ? settings.accounts.reserve : settings.accounts.revaluation;
  const missing: string[] = [];
  if (!settings.accounts.asset) missing.push("livestock on hand");
  if (!settings.accounts.valueChange) missing.push("change in value");
  if (!revaluation) missing.push(target === "reserve" ? "revaluation reserve" : "herd scheme revaluation");
  if (missing.length) {
    problems.push(`Choose the ${missing.join(", ")} account${missing.length > 1 ? "s" : ""} in Livestock › Settings.`);
    return null;
  }
  return { asset: settings.accounts.asset!, valueChange: settings.accounts.valueChange!, revaluation: revaluation! };
}

function journalLines(workings: Workings, accounts: AccountIds): JournalPreviewLine[] {
  const lines: JournalPreviewLine[] = [];
  const push = (account: AccountRef, description: string, amount: Decimal) => {
    if (isZero(amount)) return;
    const value = money(isNegative(amount) ? neg(amount) : amount);
    lines.push({
      accountCode: account.code,
      accountName: account.name,
      description,
      debit: isNegative(amount) ? "0.00" : value,
      credit: isNegative(amount) ? value : "0.00",
    });
  };
  for (const kind of workings.kinds) {
    // Debits positive: the asset moves from last year's closing to this year's.
    push(accounts.asset, `${kind.kindName}: livestock on hand`, sub(dec(kind.closingValue), dec(kind.openingValue)));
    push(accounts.revaluation, `${kind.kindName}: herd scheme revaluation (non-taxable)`, neg(dec(kind.revaluation)));
    push(accounts.valueChange, `${kind.kindName}: change in value`, neg(dec(kind.valueChange)));
  }
  return lines;
}

async function ledgerBalance(tx: OrgTx, accountCode: string, asAt: string): Promise<string> {
  const row = await tx.query<{ balance: string }>(
    `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as balance
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
      where lower(a.code) = lower($1) and j.posting_date <= $2`,
    [accountCode, asAt],
  );
  return money(dec(row.rows[0].balance));
}

/** What the valuation for a year end would be, what it would post, and anything stopping it (LV4-LV12). */
export async function previewValuation(tx: OrgTx, input: { yearEnd: unknown }): Promise<ValuationPreview> {
  const settings = await requireLivestock(tx);
  const yearEnd = requireYearEnd(settings, input.yearEnd);
  const approved = await valuationRow(tx, "year_end = $1 and status = 'approved'", [yearEnd]);
  if (approved) {
    const accounts = await postingAccounts(tx, approved.revaluationTarget, []);
    return {
      workings: approved.workings,
      revaluationTarget: approved.revaluationTarget,
      journal: accounts ? journalLines(approved.workings, accounts) : [],
      problems: [],
      ledgerOpening: null,
      approved,
    };
  }
  const { workings, problems, openingTotal, openingKnown } = await workOut(tx, yearEnd);
  const accounts = await postingAccounts(tx, settings.revaluationTarget, problems);
  let ledgerOpening: string | null = null;
  if (accounts) {
    // LV4's value bridge: the books carry last year's closing exactly, so this year's journal lands on this year's closing.
    ledgerOpening = await ledgerBalance(tx, accounts.asset.code, yearEnd);
    if (openingKnown && cmp(dec(ledgerOpening), dec(openingTotal)) !== 0) {
      problems.push(
        `Account ${accounts.asset.code} ${accounts.asset.name} shows ${ledgerOpening} at ${yearEnd}, but the livestock opening value is ${openingTotal}. Post the opening balance (or correct it) first, so the closing value ties to the balance sheet.`,
      );
    }
  }
  const later = await tx.query<{ year_end: string }>("select year_end::text from livestock_valuations where year_end > $1 and status = 'approved' limit 1", [yearEnd]);
  if (later.rows[0]) problems.push(`The valuation for the year to ${later.rows[0].year_end} is approved; replace it first.`);
  return {
    workings,
    revaluationTarget: settings.revaluationTarget,
    journal: accounts ? journalLines(workings, accounts) : [],
    problems,
    ledgerOpening,
    approved: null,
  };
}

/** Approves the valuation and posts its journal at the year end, once (LV4, LV9). Admins. */
export async function approveValuation(tx: OrgTx, input: { yearEnd: unknown; source?: unknown; idempotencyKey: unknown }): Promise<{ created: boolean; valuation: Valuation }> {
  const settings = await requireLivestock(tx);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const yearEnd = requireYearEnd(settings, input.yearEnd);
  const hash = requestHash("livestock_valuation", { yearEnd });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>(
      "select id::text, request_hash from livestock_valuations where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "livestock valuation");
    return { created: false, valuation: (await valuationRow(tx, "id = $1", [earlier.rows[0].id]))! };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await tx.query("select 1 from livestock_settings where id = true for update");
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (await valuationRow(tx, "year_end = $1 and status = 'approved'", [yearEnd])) {
    throw new ConflictError(`The valuation for the year to ${yearEnd} is already approved.`);
  }
  const preview = await previewValuation(tx, { yearEnd });
  if (preview.problems.length > 0) throw new ValidationError(`The valuation can't be approved yet: ${preview.problems.join(" ")}`);
  await assertPostingDateAllowed(tx, yearEnd);
  const { workings } = preview;
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('livestock_valuations', 'id'))::text as id");
  const id = next.rows[0].id;
  let journalId: string | null = null;
  if (preview.journal.length > 0) {
    const posted = await postJournalBody(
      tx,
      "livestock_valuation:approve",
      id,
      parseJournalBody(tx, {
        postingDate: yearEnd,
        reference: `LIVESTOCK-${yearEnd}`,
        description: `Livestock valuation for the year to ${yearEnd} (${workings.incomeYear} income year)`,
        lines: preview.journal.map((line) => ({ accountCode: line.accountCode, debitAmount: line.debit, creditAmount: line.credit, description: line.description })),
      }),
      { origin: "livestock_valuation" },
    );
    journalId = posted.journal.id;
  }
  const totals = workings.totals;
  await tx.query(
    `insert into livestock_valuations (id, command_source, idempotency_key, request_hash, year_end, income_year, revaluation_target, workings,
       opening_value, revaluation, closing_value, value_change, sales, purchases, taxable_profit, journal_id, approved_by_user_id, approved_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16, $17, $18)`,
    [
      id,
      source,
      idempotencyKey,
      hash,
      yearEnd,
      workings.incomeYear,
      preview.revaluationTarget,
      JSON.stringify(workings),
      totals.openingValue,
      totals.revaluation,
      totals.closingValue,
      totals.valueChange,
      totals.sales,
      totals.purchases,
      totals.taxableProfit,
      journalId,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "livestock.valuation_approved",
    entityType: "livestock_valuation",
    entityId: id,
    details: { yearEnd, incomeYear: workings.incomeYear, closingValue: totals.closingValue, taxableProfit: totals.taxableProfit, journalId },
  });
  return { created: true, valuation: (await valuationRow(tx, "id = $1", [id]))! };
}

/**
 * Replaces an approved valuation (LV9): its journal is reversed (never
 * edited) and the year can change and be approved again. Refused once a
 * later year's valuation is approved, or in a locked period.
 */
export async function replaceValuation(tx: OrgTx, input: { yearEnd: unknown; reason: unknown }): Promise<Valuation> {
  const settings = await requireLivestock(tx);
  const yearEnd = requireYearEnd(settings, input.yearEnd);
  const reason = requireString(input.reason, "A reason", { maxLength: 500 });
  await tx.query("select 1 from livestock_settings where id = true for update");
  const valuation = await valuationRow(tx, "year_end = $1 and status = 'approved'", [yearEnd]);
  if (!valuation) throw new NotFoundError(`There's no approved valuation for the year to ${yearEnd}.`);
  const later = await tx.query("select 1 from livestock_valuations where year_end > $1 and status = 'approved'", [yearEnd]);
  if (later.rowCount) throw new ConflictError("A later year's valuation is approved. Replace that first.");
  let reversalJournalId: string | null = null;
  if (valuation.journalId) {
    const original = await getJournal(tx, valuation.journalId);
    const posted = await postJournalBody(
      tx,
      "livestock_valuation:replace",
      valuation.id,
      parseJournalBody(tx, {
        postingDate: yearEnd,
        reference: `VOID-${original.reference}`.slice(0, 100),
        description: `Livestock valuation for the year to ${yearEnd} replaced: ${reason}`.slice(0, 500),
        lines: original.lines.map((line) => ({ accountCode: line.accountCode, debitAmount: line.creditAmount, creditAmount: line.debitAmount, description: line.description })),
      }),
      { origin: "livestock_valuation", relatedJournalId: original.id, correctionKind: "reversal" },
    );
    reversalJournalId = posted.journal.id;
  } else {
    await assertPostingDateAllowed(tx, yearEnd);
  }
  await tx.query(
    "update livestock_valuations set status = 'replaced', replace_reason = $2, reversal_journal_id = $3, replaced_by_email = $4, replaced_at = now() where id = $1",
    [valuation.id, reason, reversalJournalId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "livestock.valuation_replaced", entityType: "livestock_valuation", entityId: valuation.id, details: { yearEnd, reason, reversalJournalId } });
  return (await valuationRow(tx, "id = $1", [valuation.id]))!;
}

export async function listValuations(tx: OrgTx): Promise<Array<Omit<Valuation, "workings"> & { closingValue: string; taxableProfit: string }>> {
  const rows = await tx.query<{ id: string }>("select id::text from livestock_valuations order by year_end desc, livestock_valuations.id desc");
  const result = [];
  for (const row of rows.rows) {
    const valuation = (await valuationRow(tx, "id = $1", [row.id]))!;
    const { workings, ...rest } = valuation;
    result.push({ ...rest, closingValue: workings.totals.closingValue, taxableProfit: workings.totals.taxableProfit });
  }
  return result;
}
