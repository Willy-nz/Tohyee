import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { financialYearEnd } from "@/lib/financial-year";
import { cmp, dec, type Decimal, isNegative, mul, mulDiv, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";
import { className, findClass, KIND_NAMES, LIVESTOCK_KINDS, type LivestockKind } from "./classes";
import { requireLivestock } from "./movements";

/*
 * High-priced livestock (LV25, decision 508; IRD OS 25/02 paras 68-71): an
 * animal that cost at least 500.00 and at least five times its class's NAMV
 * (in the year bought or the year before) is valued on its own: at cost in
 * the year bought, then less IRD's depreciation rate (typed by the
 * accountant with its source) of cost each year after, until it's at or
 * below its class's NAMV, when it reverts to its class.
 */

export type HighPricedAnimal = {
  id: string;
  kind: LivestockKind;
  kindName: string;
  classCode: string;
  className: string;
  description: string;
  boughtOn: string;
  cost: string;
  ratePercent: string;
  rateSource: string;
  priorYearNamv: string | null;
  leftOn: string | null;
  leftHow: "sold_or_died" | "stopped_breeding" | null;
  leftReason: string | null;
};

type Row = {
  id: string;
  kind: LivestockKind;
  class_code: string;
  description: string;
  bought_on: string;
  cost: string;
  rate_percent: string;
  rate_source: string;
  prior_year_namv: string | null;
  left_on: string | null;
  left_how: "sold_or_died" | "stopped_breeding" | null;
  left_reason: string | null;
};

const COLUMNS = "id::text, kind, class_code, description, bought_on::text, cost::text, rate_percent::text, rate_source, prior_year_namv::text, left_on::text, left_how, left_reason";

function toAnimal(row: Row): HighPricedAnimal {
  return {
    id: row.id,
    kind: row.kind,
    kindName: KIND_NAMES[row.kind],
    classCode: row.class_code,
    className: className(row.kind, row.class_code),
    description: row.description,
    boughtOn: row.bought_on,
    cost: row.cost,
    ratePercent: row.rate_percent,
    rateSource: row.rate_source,
    priorYearNamv: row.prior_year_namv,
    leftOn: row.left_on,
    leftHow: row.left_how,
    leftReason: row.left_reason,
  };
}

export async function listHighPriced(tx: OrgTx): Promise<HighPricedAnimal[]> {
  const rows = await tx.query<Row>(`select ${COLUMNS} from livestock_high_priced order by bought_on, livestock_high_priced.id`);
  return rows.rows.map(toAnimal);
}

/** Its value at a year end (straight line on cost), before any reverting: cost in the year bought, then cost less rate x cost a year, never below 0. */
export function highPricedValueAt(animal: Pick<HighPricedAnimal, "boughtOn" | "cost" | "ratePercent">, yearEnd: string, yearEndMonth: number): Decimal {
  const boughtYearEnd = financialYearEnd(animal.boughtOn, yearEndMonth);
  if (yearEnd < boughtYearEnd) return ZERO_DECIMAL;
  const years = Number(yearEnd.slice(0, 4)) - Number(boughtYearEnd.slice(0, 4));
  const depreciation = mulDiv(mul(dec(animal.cost), dec(animal.ratePercent)), dec(String(years)), dec("100"), 2);
  const value = sub(dec(animal.cost), depreciation);
  return isNegative(value) ? ZERO_DECIMAL : value;
}

async function assertNotApproved(tx: OrgTx, from: string): Promise<void> {
  const approved = await tx.query<{ year_end: string }>("select year_end::text from livestock_valuations where year_end >= $1 and status = 'approved' order by year_end limit 1", [from]);
  if (approved.rows[0]) throw new ConflictError(`The livestock valuation for the year to ${approved.rows[0].year_end} is approved. Replace it first.`);
}

/**
 * Records a high-priced animal (LV25). It must cost at least 500.00 and at
 * least five times its class's NAMV in the income year bought and the year
 * before; the year before's NAMV is typed when Tohyee doesn't have it.
 */
export async function recordHighPriced(
  tx: OrgTx,
  input: { kind: unknown; classCode: unknown; description: unknown; boughtOn: unknown; cost: unknown; ratePercent: unknown; rateSource: unknown; priorYearNamv?: unknown },
): Promise<HighPricedAnimal> {
  const settings = await requireLivestock(tx);
  const kind = requireOneOf(input.kind, "kind", LIVESTOCK_KINDS);
  const classCode = requireString(input.classCode, "class", { maxLength: 50 });
  if (!findClass(kind, classCode)) throw new ValidationError(`${KIND_NAMES[kind]} has no class "${classCode}".`);
  const description = requireString(input.description, "A description (tag or name)", { maxLength: 200 });
  const boughtOn = parseIsoDate(input.boughtOn, "The date bought");
  if (boughtOn < settings.firstYearStart) {
    throw new ValidationError(`Livestock starts on ${settings.firstYearStart}. A high-priced animal bought before then isn't supported yet: include it in its class's opening value.`);
  }
  const cost = parseDecimalInput(input.cost, "Cost", { maxScale: 2 });
  const ratePercent = parseDecimalInput(input.ratePercent, "IRD's depreciation rate (%)", { maxScale: 2 });
  if (cmp(dec(ratePercent), dec("100")) > 0) throw new ValidationError("The depreciation rate can't be more than 100%.");
  const rateSource = requireString(input.rateSource, "Where the rate came from", { maxLength: 500 });
  const priorTyped = input.priorYearNamv === undefined || input.priorYearNamv === null || input.priorYearNamv === "" ? null : parseDecimalInput(input.priorYearNamv, "Last year's NAMV", { maxScale: 2, allowZero: true });
  await assertNotApproved(tx, boughtOn);

  // The income year bought, from the balance date (as the valuation does).
  const yearEnd = financialYearEnd(boughtOn, settings.financialYearEndMonth);
  const month = Number(yearEnd.slice(5, 7));
  const incomeYear = month >= 10 ? Number(yearEnd.slice(0, 4)) + 1 : Number(yearEnd.slice(0, 4));
  const namvOf = async (year: number) =>
    (await tx.query<{ amount: string }>("select amount::text from livestock_rates where income_year = $1 and rate_kind = 'namv' and kind = $2 and category = $3", [year, kind, classCode])).rows[0]?.amount ?? null;
  const thisYear = await namvOf(incomeYear);
  const lastYear = priorTyped ?? (await namvOf(incomeYear - 1));
  if (thisYear === null) throw new ValidationError(`Tohyee has no ${incomeYear} NAMV for ${className(kind, classCode).toLowerCase()}. Add it in IRD rates first.`);
  if (lastYear === null) throw new ValidationError(`Type the ${incomeYear - 1} NAMV for ${className(kind, classCode).toLowerCase()} (Tohyee doesn't have it), so the high-priced test can be checked.`);
  const higher = cmp(dec(thisYear), dec(lastYear)) >= 0 ? thisYear : lastYear;
  const threshold = mul(dec(higher), dec("5"));
  if (cmp(dec(cost), dec("500")) < 0 || cmp(dec(cost), threshold) < 0) {
    throw new ValidationError(`It isn't high-priced: it has to cost at least 500.00 and at least five times the NAMV (5 x ${higher} = ${toFixedString(threshold, 2)}).`);
  }
  const row = await tx.query<{ id: string }>(
    `insert into livestock_high_priced (kind, class_code, description, bought_on, cost, rate_percent, rate_source, prior_year_namv, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8::numeric, $9) returning id::text`,
    [kind, classCode, description, boughtOn, cost, ratePercent, rateSource, priorTyped, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "livestock.high_priced_recorded",
    entityType: "livestock_high_priced",
    entityId: row.rows[0].id,
    details: { kind, classCode, description, boughtOn, cost, ratePercent, rateSource },
  });
  return (await listHighPriced(tx)).find((animal) => animal.id === row.rows[0].id)!;
}

/** Records that a high-priced animal was sold or died (record the movement too), or stopped breeding (it reverts to its class). */
export async function highPricedLeft(tx: OrgTx, idInput: unknown, input: { leftOn: unknown; how: unknown; reason?: unknown }): Promise<HighPricedAnimal> {
  await requireLivestock(tx);
  const id = requireId(idInput, "animalId");
  const leftOn = parseIsoDate(input.leftOn, "The date");
  const how = requireOneOf(input.how, "how", ["sold_or_died", "stopped_breeding"] as const);
  const reason = optionalString(input.reason, "reason", { maxLength: 500 });
  const found = await tx.query<Row>(`select ${COLUMNS} from livestock_high_priced where id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("High-priced animal not found.");
  if (leftOn < found.rows[0].bought_on) throw new ValidationError("It can't leave before it was bought.");
  await assertNotApproved(tx, leftOn);
  await tx.query("update livestock_high_priced set left_on = $2, left_how = $3, left_reason = $4 where id = $1", [id, leftOn, how, reason]);
  await writeAuditEvent(tx, { eventType: "livestock.high_priced_left", entityType: "livestock_high_priced", entityId: id, details: { leftOn, how, reason } });
  return toAnimal((await tx.query<Row>(`select ${COLUMNS} from livestock_high_priced where id = $1`, [id])).rows[0]);
}
