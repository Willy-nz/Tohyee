import { parseIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import {
  abs,
  add,
  cmp,
  dec,
  type Decimal,
  isNegative,
  isZero,
  mulDiv,
  neg,
  parseDecimalInput,
  sub,
  sum,
  toFixedString,
  ZERO_DECIMAL,
} from "@/lib/money/decimal";
import { GST_BASIS_LABELS, type GstBasis } from "@/lib/tax/categories";

/**
 * The GST return's box maths (NZ GST101A, boxes 5-15), periods and
 * adjustments. Pure, so it's shared with the browser and unit tested on its
 * own; the documents that feed it are read in `gst-return.ts`.
 */

/** A return covers this many whole calendar months. */
export const GST_RETURN_PERIOD_MONTHS = [1, 2, 6] as const;

/** The only GST rate handled: standard-rated lines at any other rate are refused. */
export const GST_STANDARD_RATE = "0.15";

export const GST_BOX_KEYS = [
  "box5",
  "box6",
  "box7",
  "box8",
  "box9",
  "box10",
  "box11",
  "box12",
  "box13",
  "box14",
  "box15",
] as const;
export type GstBoxKey = (typeof GST_BOX_KEYS)[number];
export type GstBoxes = Record<GstBoxKey, string>;

/** Short descriptions of each box, in the order of the IRD form. */
export const GST_BOX_LABELS: Readonly<Record<GstBoxKey, string>> = {
  box5: "Total sales and income, including GST and zero-rated supplies",
  box6: "Zero-rated supplies included in Box 5",
  box7: "Box 5 less Box 6",
  box8: "GST on Box 7 (Box 7 x 3 / 23)",
  box9: "Debit adjustments",
  box10: "Total GST collected on sales and income (Box 8 + Box 9)",
  box11: "Total purchases and expenses, including GST",
  box12: "GST on Box 11 (Box 11 x 3 / 23)",
  box13: "Credit adjustments",
  box14: "Total GST credit for purchases and expenses (Box 12 + Box 13)",
  box15: "Box 10 less Box 14: GST to pay, or a refund if negative",
};

/** The box number shown to people, e.g. "box11" -> "11". */
export function gstBoxNumber(box: GstBoxKey): string {
  return box.slice(3);
}

export const GST_ADJUSTMENT_BOXES = ["9", "13"] as const;
export type GstAdjustmentBox = (typeof GST_ADJUSTMENT_BOXES)[number];

/** A GST amount typed in for Box 9 (debit) or Box 13 (credit), with what it's for. */
export type GstAdjustment = { box: GstAdjustmentBox; description: string; amount: string };

export const MAX_GST_ADJUSTMENTS = 50;

const MONEY_SCALE = 2;

function money(value: Decimal): string {
  return toFixedString(value, MONEY_SCALE);
}

function monthIndex(isoDate: string): number {
  return Number(isoDate.slice(0, 4)) * 12 + Number(isoDate.slice(5, 7)) - 1;
}

/** The last day of the month `months` months on from `periodStart`'s month (YYYY-MM-DD). */
export function gstPeriodEnd(periodStart: string, months: number): string {
  const index = monthIndex(periodStart) + months;
  const lastDay = new Date(Date.UTC(Math.floor(index / 12), index % 12, 0));
  return lastDay.toISOString().slice(0, 10);
}

/**
 * A return covers 1, 2 or 6 whole calendar months: it starts on the 1st and
 * ends on the last day of a month.
 */
export function parseGstPeriod(
  periodStartInput: unknown,
  periodEndInput: unknown,
): { periodStart: string; periodEnd: string; months: number } {
  const periodStart = parseIsoDate(periodStartInput, "periodStart");
  const periodEnd = parseIsoDate(periodEndInput, "periodEnd");
  if (!periodStart.endsWith("-01")) {
    throw new ValidationError("A GST return starts on the 1st of a month.");
  }
  if (periodEnd < periodStart) {
    throw new ValidationError("periodEnd must be after periodStart.");
  }
  const months = monthIndex(periodEnd) - monthIndex(periodStart) + 1;
  if (gstPeriodEnd(periodStart, months) !== periodEnd) {
    throw new ValidationError("A GST return ends on the last day of a month.");
  }
  if (!(GST_RETURN_PERIOD_MONTHS as readonly number[]).includes(months)) {
    throw new ValidationError(`A GST return covers 1, 2 or 6 whole months, not ${months}.`);
  }
  return { periodStart, periodEnd, months };
}

// ---------------------------------------------------------------------------
// The GST period setting (GP1-GP6), like NetSuite's tax periods

/**
 * How often the organisation files GST, and which months its periods end in
 * (IRD: monthly, two-monthly or six-monthly; two-monthly periods end in odd
 * or even months). `endMonth` is the first month of the year a period ends
 * in: 1 for monthly, 1 (odd) or 2 (even) for two-monthly, and 1-6 for
 * six-monthly (3 is March and September).
 */
export type GstPeriodSetting = { months: 1 | 2 | 6; endMonth: number };

const FULL_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The setting from any month a period ends in (e.g. two-monthly ending in September is odd months: 1). */
export function gstPeriodSetting(months: number, anyEndMonth: number): GstPeriodSetting {
  if (!(GST_RETURN_PERIOD_MONTHS as readonly number[]).includes(months)) {
    throw new ValidationError("The GST filing frequency is monthly (1), two-monthly (2) or six-monthly (6).");
  }
  if (!Number.isInteger(anyEndMonth) || anyEndMonth < 1 || anyEndMonth > 12) {
    throw new ValidationError("The month a GST period ends in is a month number from 1 to 12.");
  }
  return { months: months as GstPeriodSetting["months"], endMonth: ((anyEndMonth - 1) % months) + 1 };
}

/** "Two-monthly, ending in odd months (January, March, May...)". */
export function describeGstPeriodSetting(setting: GstPeriodSetting): string {
  if (setting.months === 1) return "Monthly";
  if (setting.months === 2) {
    return setting.endMonth === 1
      ? "Two-monthly, ending in odd months (January, March, May, July, September, November)"
      : "Two-monthly, ending in even months (February, April, June, August, October, December)";
  }
  return `Six-monthly, ending in ${FULL_MONTH_NAMES[setting.endMonth - 1]} and ${FULL_MONTH_NAMES[setting.endMonth + 5]}`;
}

/** The last day of the first period (by the setting) that ends on or after `date`. */
export function gstPeriodEndOnOrAfter(setting: GstPeriodSetting, date: string): string {
  let index = monthIndex(date);
  while ((((index % 12) + 1 - setting.endMonth) % setting.months + setting.months) % setting.months !== 0) index += 1;
  return gstPeriodEnd(`${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`, 1);
}

/** The period (by the setting) that `date` is in (GP1). */
export function gstPeriodContaining(setting: GstPeriodSetting, date: string): { periodStart: string; periodEnd: string } {
  const periodEnd = gstPeriodEndOnOrAfter(setting, date);
  const startIndex = monthIndex(periodEnd) - setting.months + 1;
  const periodStart = `${String(Math.floor(startIndex / 12)).padStart(4, "0")}-${String((startIndex % 12) + 1).padStart(2, "0")}-01`;
  return { periodStart, periodEnd };
}

function nextDay(date: string): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + 1);
  return moved.toISOString().slice(0, 10);
}

function previousDay(date: string): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() - 1);
  return moved.toISOString().slice(0, 10);
}

/**
 * The GST period after a filed return (GP2, GP3): from the day after it to
 * the end of the setting's period that day is in (shorter than usual when
 * the frequency changed). Without a setting, the same length as the filed
 * return (H4, the old rule).
 */
export function gstPeriodAfter(
  setting: GstPeriodSetting | null,
  filed: { periodStart: string; periodEnd: string },
): { periodStart: string; periodEnd: string } {
  const periodStart = nextDay(filed.periodEnd);
  if (setting) return { periodStart, periodEnd: gstPeriodEndOnOrAfter(setting, periodStart) };
  const months = monthIndex(filed.periodEnd) - monthIndex(filed.periodStart) + 1;
  return { periodStart, periodEnd: gstPeriodEnd(periodStart, months) };
}

/**
 * The period the GST return opens on (GP4): the one after the latest filed
 * return; with none filed, the latest period (by the setting) that has
 * ended before `today`. Null with neither a filed return nor a setting.
 */
export function suggestedGstPeriod(
  setting: GstPeriodSetting | null,
  latestFiled: { periodStart: string; periodEnd: string } | null,
  today: string,
): { periodStart: string; periodEnd: string } | null {
  if (latestFiled) return gstPeriodAfter(setting, latestFiled);
  if (!setting) return null;
  // The period today is in hasn't ended yet, so it's the one before it.
  return gstPeriodContaining(setting, previousDay(gstPeriodContaining(setting, today).periodStart));
}

/** Box 9 and Box 13 adjustments: each a GST amount more than zero with at most 2 decimal places. */
export function parseGstAdjustments(input: unknown): GstAdjustment[] {
  if (input == null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new ValidationError("adjustments must be a list.");
  }
  if (input.length > MAX_GST_ADJUSTMENTS) {
    throw new ValidationError(`A GST return can have at most ${MAX_GST_ADJUSTMENTS} adjustments.`);
  }
  return input.map((entry, index) => {
    const field = `adjustments[${index}]`;
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ValidationError(`${field} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const box = typeof record.box === "number" ? String(record.box) : record.box;
    if (typeof box !== "string" || !(GST_ADJUSTMENT_BOXES as readonly string[]).includes(box.trim())) {
      throw new ValidationError(`${field}.box must be 9 (debit adjustment) or 13 (credit adjustment).`);
    }
    if (typeof record.description !== "string" || record.description.trim().length === 0) {
      throw new ValidationError(`${field}.description is required, e.g. "Bad debt recovered".`);
    }
    const description = record.description.trim();
    if (description.length > 200) {
      throw new ValidationError(`${field}.description can be at most 200 characters.`);
    }
    const amount = parseDecimalInput(record.amount, `${field}.amount`, { maxScale: MONEY_SCALE });
    return { box: box.trim() as GstAdjustmentBox, description, amount: money(dec(amount)) };
  });
}

export type GstReturnFigures = {
  boxes: GstBoxes;
  /** The counted lines' own GST, for comparing with Box 8 and Box 12 (rounding). Information only. */
  gstOnTransactions: {
    sales: string;
    purchases: string;
    /** Box 8 less the sales lines' GST. */
    salesDifference: string;
    /** Box 12 less the purchase lines' GST. */
    purchasesDifference: string;
  };
};

/**
 * Boxes 5-15 from the totals of the counted lines and the adjustments:
 * Box 7 = 5 - 6, Box 8 = 7 x 3 / 23, Box 10 = 8 + 9, Box 12 = 11 x 3 / 23,
 * Box 14 = 12 + 13, Box 15 = 10 - 14. Amounts are exact, rounded once to
 * 2 places, half away from zero.
 */
export function calculateGstBoxes(input: {
  box5: string;
  box6: string;
  box11: string;
  salesGst: string;
  purchasesGst: string;
  adjustments: readonly GstAdjustment[];
}): GstReturnFigures {
  const three = dec("3");
  const twentyThree = dec("23");
  let box9 = ZERO_DECIMAL;
  let box13 = ZERO_DECIMAL;
  for (const adjustment of input.adjustments) {
    if (adjustment.box === "9") box9 = add(box9, dec(adjustment.amount));
    else box13 = add(box13, dec(adjustment.amount));
  }
  const box5 = dec(input.box5);
  const box6 = dec(input.box6);
  const box7 = sub(box5, box6);
  const box8 = mulDiv(box7, three, twentyThree, MONEY_SCALE);
  const box10 = add(box8, box9);
  const box11 = dec(input.box11);
  const box12 = mulDiv(box11, three, twentyThree, MONEY_SCALE);
  const box14 = add(box12, box13);
  const box15 = sub(box10, box14);
  const salesGst = dec(input.salesGst);
  const purchasesGst = dec(input.purchasesGst);
  return {
    boxes: {
      box5: money(box5),
      box6: money(box6),
      box7: money(box7),
      box8: money(box8),
      box9: money(box9),
      box10: money(box10),
      box11: money(box11),
      box12: money(box12),
      box13: money(box13),
      box14: money(box14),
      box15: money(box15),
    },
    gstOnTransactions: {
      sales: money(salesGst),
      purchases: money(purchasesGst),
      salesDifference: money(sub(box8, salesGst)),
      purchasesDifference: money(sub(box12, purchasesGst)),
    },
  };
}

export type GstBoxChange = { box: GstBoxKey; filed: string; current: string };

/** The boxes whose amounts differ, in box order. */
export function changedGstBoxes(filed: GstBoxes, current: GstBoxes): GstBoxChange[] {
  return GST_BOX_KEYS.filter((box) => cmp(dec(filed[box]), dec(current[box])) !== 0).map((box) => ({
    box,
    filed: filed[box],
    current: current[box],
  }));
}

export type GstSide = "sales" | "purchases";

/**
 * Whether a side's documents count when they're settled (paid, credited or
 * refunded) rather than when they're approved: everything on the payments
 * basis, purchases on the hybrid basis (G10-G18).
 */
export function countsWhenSettled(basis: GstBasis, side: GstSide): boolean {
  return basis === "payments" || (basis === "hybrid" && side === "purchases");
}

/**
 * The index of the line with the largest size (the first one on a tie).
 */
function largestIndex(values: readonly Decimal[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (cmp(abs(values[index]), abs(values[best])) > 0) best = index;
  }
  return best;
}

/**
 * Shares `value x settled / total` of each value, rounded to 2 places, with
 * the cents left over from rounding given to the largest value so the shares
 * add up to `target`.
 */
function shareOut(values: readonly Decimal[], settled: Decimal, total: Decimal, target: Decimal): Decimal[] {
  const shares = values.map((value) => mulDiv(value, settled, total, MONEY_SCALE));
  const leftover = sub(target, sum(shares));
  if (!isZero(leftover) && values.length > 0) {
    const index = largestIndex(values);
    shares[index] = add(shares[index], leftover);
  }
  return shares;
}

/**
 * A settlement's share of each document line (G11, G12): line amount x amount
 * settled / document total, rounded to 2 places, with any leftover cent on
 * the largest line so the shares add up to exactly the amount settled. GST
 * shares the same way, adding up to the document's GST x settled / total.
 * Amounts include GST. Returns positive shares for a positive settlement.
 */
export function settlementShares(
  lines: readonly { amount: string; gst: string }[],
  settledInput: string,
  totalInput: string,
): { amount: string; gst: string }[] {
  const settled = dec(settledInput);
  const total = dec(totalInput);
  if (lines.length === 0 || isZero(total)) return lines.map(() => ({ amount: "0.00", gst: "0.00" }));
  const amounts = lines.map((line) => dec(line.amount));
  const gsts = lines.map((line) => dec(line.gst));
  const amountShares = shareOut(amounts, settled, total, settled);
  const gstTarget = mulDiv(sum(gsts), settled, total, MONEY_SCALE);
  const gstShares = shareOut(gsts, settled, total, gstTarget);
  return amountShares.map((amount, index) => ({ amount: money(amount), gst: money(gstShares[index]) }));
}

/** GST included in what's still owed on a document: owed x GST / total, rounded to 2 places. */
export function gstInOutstanding(owed: string, gst: string, total: string): string {
  if (isZero(dec(total))) return "0.00";
  return money(mulDiv(dec(owed), dec(gst), dec(total), MONEY_SCALE));
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function longDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * The IR546 adjustment for a change of GST basis (G20, G21): GST on debtors
 * when sales move from counting when settled to counting when approved (less
 * it the other way), plus GST on creditors when purchases move from counting
 * when approved to counting when settled (less it the other way). More than
 * 0 is a Box 9 adjustment, less than 0 a Box 13 one; 0 is none.
 */
export function basisChangeAdjustment(input: {
  from: GstBasis;
  to: GstBasis;
  asAt: string;
  debtorsGst: string;
  creditorsGst: string;
}): GstAdjustment | null {
  const parts: string[] = [];
  let total = ZERO_DECIMAL;
  const salesBefore = countsWhenSettled(input.from, "sales");
  const salesAfter = countsWhenSettled(input.to, "sales");
  if (salesBefore !== salesAfter) {
    const debtors = dec(input.debtorsGst);
    total = add(total, salesBefore ? debtors : neg(debtors));
    parts.push(`GST on debtors ${money(debtors)}`);
  }
  const purchasesBefore = countsWhenSettled(input.from, "purchases");
  const purchasesAfter = countsWhenSettled(input.to, "purchases");
  if (purchasesBefore !== purchasesAfter) {
    const creditors = dec(input.creditorsGst);
    total = add(total, purchasesAfter ? creditors : neg(creditors));
    parts.push(`GST on creditors ${money(creditors)}`);
  }
  if (parts.length === 0 || isZero(total)) return null;
  const label = (basis: GstBasis) => GST_BASIS_LABELS[basis].replace(/ basis$/, "").toLowerCase();
  return {
    box: isNegative(total) ? "13" : "9",
    description: `Change of GST basis from ${label(input.from)} to ${label(input.to)} at ${longDate(input.asAt)}: ${parts.join(", ")}`,
    amount: money(abs(total)),
  };
}
