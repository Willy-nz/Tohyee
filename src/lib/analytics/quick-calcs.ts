import { ValidationError } from "@/lib/errors";
import { divide, dec, isZero, toFixedString } from "@/lib/money/decimal";
import { formulaRefs, parseFormula, type FormulaNode } from "@/lib/analytics/formula";

/**
 * Quick calculations on a value (#376 phase 4, decision 770; Power BI's
 * "Show value as" and quick measures, Looker Studio's running and
 * comparison calculations). The value is still worked out from the rows as
 * before; the quick calculation then changes what's shown for it in each
 * group. Every denominator and every run is stated (decision 770), so a
 * reader can tell what "% of total" is a share of.
 */
export type QuickKind =
  | "running_total"
  | "percent_of_total"
  | "percent_of_row"
  | "percent_of_column"
  | "rank"
  | "difference"
  | "percent_change"
  | "moving_average";

export type QuickCalc = {
  kind: QuickKind;
  /** A moving average's periods (or groups), the current one included: 2 to 12. */
  periods?: number;
  /** Rank: the smallest value is 1 (left out, the largest is). */
  smallestFirst?: true;
};

export const QUICK_KINDS: ReadonlyArray<{ value: QuickKind; label: string }> = [
  { value: "running_total", label: "Running total" },
  { value: "percent_of_total", label: "% of total" },
  { value: "percent_of_row", label: "% of row (its group)" },
  { value: "percent_of_column", label: "% of column" },
  { value: "rank", label: "Rank" },
  { value: "difference", label: "Difference from previous" },
  { value: "percent_change", label: "% change from previous" },
  { value: "moving_average", label: "Moving average" },
];

export const MIN_MOVING_PERIODS = 2;
export const MAX_MOVING_PERIODS = 12;
export const DEFAULT_MOVING_PERIODS = 3;

/** The values shown as a share, as fractions (0.25 is 25%). */
export function quickIsPercent(quick: QuickCalc | undefined): boolean {
  return quick?.kind === "percent_of_total" || quick?.kind === "percent_of_row" || quick?.kind === "percent_of_column" || quick?.kind === "percent_change";
}

/** What a value is, as far as a quick calculation needs to know. */
export type QuickTarget = {
  label: string;
  aggregate: string;
  formula?: string;
  /** The aggregates of the values a formula names (its inputs or the tile's other values). */
  inputAggregates?: string[];
  asAt?: boolean;
  snapshot?: unknown;
  compare?: string;
  /** The value's rows name their currency (decision 694). */
  currency: boolean;
};

/** Where the value is: a chart or table grouped by something (with or without a second grouping), a pivot table, or one total. */
export type QuickPlace = { kind: "grouped"; breakdown: boolean } | { kind: "pivot"; column: boolean } | { kind: "total" };

const ADDED_UP = new Set(["sum", "count"]);

/** Whether a formula only adds and takes away (so a run of it is the formula of the runs). */
function onlyAddsUp(node: FormulaNode): boolean {
  if (node.kind === "binary") return (node.op === "+" || node.op === "-") && onlyAddsUp(node.left) && onlyAddsUp(node.right);
  if (node.kind === "negate") return onlyAddsUp(node.operand);
  return node.kind === "ref";
}

/**
 * Checks a value's quick calculation, or explains why it can't have it.
 * Left out or "none", there's none.
 */
export function parseQuickCalc(raw: unknown, target: QuickTarget, place: QuickPlace): QuickCalc | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === "none") return undefined;
  const entry = (typeof raw === "string" ? { kind: raw } : raw) as Record<string, unknown>;
  const kind = entry.kind as QuickKind;
  const label = target.label;
  if (!QUICK_KINDS.some((option) => option.value === kind)) throw new ValidationError(`${label}: choose a quick calculation from the list.`);
  if (place.kind === "total") throw new ValidationError(`${label}: a quick calculation needs the tile grouped by something; with one total there's nothing to compare it with.`);
  if (target.compare) throw new ValidationError(`${label}: a value can compare with last year or have a quick calculation, not both. Add the value again for the other one.`);
  if (target.currency) {
    throw new ValidationError(`${label}: its rows are in more than one currency, so a quick calculation would add or compare different currencies. Use the amount in the organisation's currency.`);
  }
  if (place.kind === "pivot") {
    if (kind !== "percent_of_total" && kind !== "percent_of_row" && kind !== "percent_of_column") {
      throw new ValidationError(`${label}: a pivot table can show a value as a % of the total, of its row or of its column.`);
    }
    if (kind === "percent_of_row" && !place.column) throw new ValidationError(`${label}: % of row needs a pivot column, so each row has a total across the columns.`);
  }
  if (place.kind === "grouped" && (kind === "percent_of_row" || kind === "percent_of_column") && !place.breakdown) {
    throw new ValidationError(`${label}: % of row and % of column need a second grouping or a pivot table; with one grouping, use % of total.`);
  }
  const balance = Boolean(target.asAt || target.snapshot);
  const result: QuickCalc = { kind };
  if (kind === "running_total") {
    if (balance) throw new ValidationError(`${label}: a balance is already a total up to its date, so a running total would add balances together.`);
    const addsUp = target.aggregate === "formula" ? (target.inputAggregates ?? []).every((aggregate) => ADDED_UP.has(aggregate)) : ADDED_UP.has(target.aggregate);
    if (!addsUp) {
      throw new ValidationError(`${label}: a running total adds groups up, which only works for a total or a count (or a formula of them), not an average, smallest, largest or count of different values.`);
    }
  }
  if (kind === "moving_average") {
    const addsUp = target.aggregate === "formula" ? false : ADDED_UP.has(target.aggregate);
    if (!addsUp && !(target.aggregate === "formula" && target.formula && safeOnlyAddsUp(target.formula) && (target.inputAggregates ?? []).every((aggregate) => ADDED_UP.has(aggregate)))) {
      throw new ValidationError(`${label}: a moving average averages each group's value, which only makes sense for a total or a count (or a formula that only adds and takes them away), not for averages or ratios.`);
    }
    const periods = entry.periods === undefined || entry.periods === null || entry.periods === "" ? DEFAULT_MOVING_PERIODS : Number(entry.periods);
    if (!Number.isInteger(periods) || periods < MIN_MOVING_PERIODS || periods > MAX_MOVING_PERIODS) {
      throw new ValidationError(`${label}: a moving average is over ${MIN_MOVING_PERIODS} to ${MAX_MOVING_PERIODS} periods.`);
    }
    result.periods = periods;
  }
  if (kind === "rank" && entry.smallestFirst === true) result.smallestFirst = true;
  return result;
}

function safeOnlyAddsUp(formula: string): boolean {
  try {
    return onlyAddsUp(parseFormula(formula));
  } catch {
    return false;
  }
}

/** The names a formula uses, or none when it doesn't parse (it's checked elsewhere). */
export function safeFormulaRefs(formula: string | undefined): string[] {
  try {
    return formula ? formulaRefs(parseFormula(formula)) : [];
  } catch {
    return [];
  }
}

/**
 * What a quick calculation shows, in words, with its denominator or run
 * (decision 770): "of" what, along what, and how blanks and Top N work.
 * `dated`: the tile is grouped by a date, so runs go by calendar periods.
 */
export function describeQuickCalc(quick: QuickCalc, options: { dated: boolean; breakdown: boolean; pivot: boolean }): string {
  const scope = "the rows the tile's filters, the report's dates, slicers and any clicks leave, before Top N";
  const along = options.dated ? "oldest period first" : "in the groups' A to Z order, whatever the chart is sorted by";
  const each = options.breakdown ? ", separately for each value of the second grouping" : "";
  const step = options.dated ? "the period just before (a missing period is blank, not 0)" : "the group before it (A to Z)";
  switch (quick.kind) {
    case "running_total":
      return `a running total, ${along}${each}: each group adds its value to the ones before it, from the start of the dates (a blank adds nothing). A formula is worked out again from the running totals of what it names.`;
    case "percent_of_total":
      return options.pivot
        ? `each cell as a share of the grand total, worked out again from all the rows (${scope})`
        : `each group as a share of the value worked out again from all of ${scope}, so with Top N the shares shown don't add to 100%`;
    case "percent_of_row":
      return options.pivot ? "each cell as a share of its row's total across the columns" : "each value as a share of its first group's total, across the second grouping";
    case "percent_of_column":
      return options.pivot ? "each cell as a share of its column's grand total" : "each value as a share of its second group's total, across the first grouping";
    case "rank":
      return `the group's place among all of them (${scope}), ${quick.smallestFirst ? "smallest" : "largest"} first; equal values share a place and the next is skipped (1, 2, 2, 4); a blank isn't ranked`;
    case "difference":
      return `the value less the value for ${step}${each}; blank when either is blank`;
    case "percent_change":
      return `the change from ${step}${each}, as a share of that earlier value; blank when either is blank or the earlier value is 0`;
    case "moving_average":
      return `the average of this ${options.dated ? "period" : "group"} and the ${(quick.periods ?? DEFAULT_MOVING_PERIODS) - 1} before it${each}, ${
        options.dated ? "by calendar periods" : "in A to Z order"
      }; only those with a value count (a blank isn't 0), so the first ones average fewer`;
  }
}

/**
 * A quick calculation's figure in a table's totals row (decision 770): a
 * share's total is 100% (blank when the total is blank or 0); a running
 * total's is the value's total; a rank, difference, change or moving
 * average has none.
 */
export function quickTotal(quick: QuickCalc, total: string | null): string | null {
  switch (quick.kind) {
    case "percent_of_total":
    case "percent_of_row":
    case "percent_of_column":
      return total === null || isZero(dec(total)) ? null : "1.000000";
    case "running_total":
      return total;
    default:
      return null;
  }
}

/** What a quick calculation's figures are, given the value's own unit (decision 770). */
export function quickUnit(quick: QuickCalc, unit: string): string {
  if (quickIsPercent(quick)) return `a percentage (worked out from ${unit})`;
  if (quick.kind === "rank") return "a place: 1 is the first";
  return unit;
}

/** How a quick calculation's totals work, in words (decision 770). */
export function quickTotalsText(kind: QuickKind): string {
  if (kind === "percent_of_total" || kind === "percent_of_row" || kind === "percent_of_column") return "a total of the shares is 100% (blank when the whole is blank or 0)";
  if (kind === "running_total") return "the total is the value's total over all the rows (where the run ends with no Top N)";
  return "no total: a rank, difference, change or moving average isn't added up";
}

/** A share worked out exactly to six places (0.250000 is 25%), or blank when either side is blank or the whole is 0. */
export function shareOf(part: string | null | undefined, whole: string | null | undefined): string | null {
  if (part === null || part === undefined || whole === null || whole === undefined) return null;
  const denominator = dec(whole);
  if (isZero(denominator)) return null;
  return toFixedString(divide(dec(part), denominator, 6), 6);
}
