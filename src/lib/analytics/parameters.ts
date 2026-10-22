import { ValidationError } from "@/lib/errors";
import { cmp, dec, divide, isZero, sub, toPlainString, truncate } from "@/lib/money/decimal";
import { definitionToSave, measureFromSaved } from "@/lib/analytics/measure-library";
import { formulaParameters, parseFormula } from "@/lib/analytics/formula";
import type { ChartFormat } from "@/lib/analytics/chart-format";
import type { ColumnInfo, Grain, Measure, TileQuery } from "@/lib/analytics/query";

/**
 * Parameters (#376 phase 4, decision 773; Power BI's what-if parameters
 * and field parameters, Looker Studio's parameters and "optional metrics"
 * and "alternative dimensions" as the references).
 *
 * - A report's **what-if parameters**: a number the reader chooses with a
 *   slider, used in values' formulas as @name (e.g. [Sales] * (1 + @growth)).
 * - A tile's **switches**: the reader shows one of the tile's own values at
 *   a time, or groups it by one of the other fields the tile's author
 *   listed. Only the saved choices can be picked (by position), so a reader
 *   can't ask the tile anything its author didn't put there.
 */

export type NumberParameter = { id: string; name: string; label: string; min: string; max: string; step: string; value: string };

export type TileSwitches = {
  /** The reader shows one of the tile's values at a time. */
  values?: true;
  /** Other groupings the reader can choose (the tile's own comes first, as choice 0). */
  groupings?: Array<{ field: string; grain?: Grain }>;
};

/** What a reader chose on a tile: which of its values (by position) and which grouping (0 is the tile's own). */
export type TileChoice = { value?: number; grouping?: number };

export const MAX_PARAMETERS = 10;
export const MAX_GROUPINGS = 8;
const NAME = /^[a-z][a-z0-9_]{0,30}$/;
const NUMBER = /^-?\d{1,12}(\.\d{1,6})?$/;

function numberText(value: unknown, what: string): string {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!NUMBER.test(text)) throw new ValidationError(`${what}: enter a number (up to 6 decimal places).`);
  return toPlainString(dec(text));
}

/** Whether a value is one of a parameter's steps: min, min + step, …, up to max. */
export function onStep(parameter: Pick<NumberParameter, "min" | "max" | "step">, value: string): boolean {
  const number = dec(value);
  if (cmp(number, dec(parameter.min)) < 0 || cmp(number, dec(parameter.max)) > 0) return false;
  const steps = divide(sub(number, dec(parameter.min)), dec(parameter.step), 6);
  return cmp(steps, truncate(steps, 0)) === 0;
}

/** A report's what-if parameters, checked (unknown settings dropped, bad ones refused). */
export function parseParameters(input: unknown): NumberParameter[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length > MAX_PARAMETERS) throw new ValidationError(`A report can have up to ${MAX_PARAMETERS} parameters.`);
  const names = new Set<string>();
  const ids = new Set<string>();
  const parameters = input.map((entry, index): NumberParameter => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
    const what = `Parameter ${index + 1}`;
    if (!NAME.test(name)) throw new ValidationError(`${what}: name it in small letters, numbers and underscores, starting with a letter, e.g. growth (used as @growth).`);
    if (names.has(name)) throw new ValidationError(`${what}: there's already a parameter called ${name}.`);
    names.add(name);
    const id = typeof raw.id === "string" && /^[a-z0-9-]{1,40}$/.test(raw.id) && !ids.has(raw.id) ? raw.id : `p-${name.replaceAll("_", "-")}`.slice(0, 40);
    ids.add(id);
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 60) : name;
    const min = numberText(raw.min, `${label} smallest`);
    const max = numberText(raw.max, `${label} largest`);
    const step = numberText(raw.step, `${label} step`);
    const value = numberText(raw.value, `${label} starting value`);
    if (cmp(dec(min), dec(max)) >= 0) throw new ValidationError(`${label}: the smallest should be less than the largest.`);
    if (cmp(dec(step), dec("0")) <= 0 || isZero(dec(step))) throw new ValidationError(`${label}: the step should be more than 0.`);
    const parameter = { id, name, label, min, max, step, value };
    if (cmp(divide(sub(dec(max), dec(min)), dec(step), 0), dec("1000")) > 0) throw new ValidationError(`${label}: a slider can have up to 1,000 steps.`);
    if (!onStep(parameter, value)) throw new ValidationError(`${label}: the starting value should be one of the slider's steps, from ${min} to ${max}.`);
    return parameter;
  });
  return parameters.length ? parameters : undefined;
}

/**
 * The parameters' values for a question: each reader's choice when it's one
 * of the slider's steps, otherwise refused; a parameter not chosen has its
 * starting value. Only the report's own parameters count (others are dropped).
 */
export function parameterValues(parameters: readonly NumberParameter[] | undefined, chosen: unknown): Record<string, string> {
  const values: Record<string, string> = {};
  const raw = chosen && typeof chosen === "object" && !Array.isArray(chosen) ? (chosen as Record<string, unknown>) : {};
  for (const parameter of parameters ?? []) {
    const given = raw[parameter.name];
    if (given === undefined || given === null || given === "") {
      values[parameter.name] = parameter.value;
      continue;
    }
    const text = numberText(given, parameter.label);
    if (!onStep(parameter, text)) throw new ValidationError(`${parameter.label}: choose a value from ${parameter.min} to ${parameter.max} in steps of ${parameter.step}.`);
    values[parameter.name] = text;
  }
  return values;
}

/** A question being built (viewers and up, who can ask anything): any numbers, checked as numbers. */
export function draftParameterValues(chosen: unknown): Record<string, string> {
  const raw = chosen && typeof chosen === "object" && !Array.isArray(chosen) ? (chosen as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(raw)
      .slice(0, MAX_PARAMETERS)
      .filter(([name]) => NAME.test(name))
      .map(([name, value]) => [name, numberText(value, name)]),
  );
}

/** The parameters a tile's formulas use, so a report can be checked to have them. */
export function tileParameters(query: Pick<TileQuery, "measures"> | null): string[] {
  const names = new Set<string>();
  for (const measure of query?.measures ?? []) {
    if (measure.aggregate !== "formula" || !measure.formula) continue;
    for (const name of formulaParameters(parseFormula(measure.formula))) names.add(name);
  }
  return [...names];
}

/**
 * A tile's switches, checked against its question and table: a value
 * switch needs two or more values; groupings are other columns of the
 * tile's table, not on pivots or tiles with drill-down levels.
 */
export function parseSwitches(input: unknown, query: TileQuery, columns: ColumnInfo[], options: { title: string; drill: boolean; visual: string }): TileSwitches | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = (typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const { title } = options;
  const result: TileSwitches = {};
  if (raw.values === true) {
    if (query.pivot || options.visual === "kpi" || options.visual === "scatter" || options.visual === "pointmap") throw new ValidationError(`${title}: this chart type uses all its values together, so the reader can't switch between them.`);
    if (query.measures.length < 2) throw new ValidationError(`${title}: add two or more values for the reader to switch between.`);
    result.values = true;
  }
  if (raw.groupings !== undefined && raw.groupings !== null) {
    if (!Array.isArray(raw.groupings) || raw.groupings.length > MAX_GROUPINGS) throw new ValidationError(`${title}: the reader can switch between up to ${MAX_GROUPINGS} other groupings.`);
    if (raw.groupings.length) {
      if (!query.groupBy || query.pivot) throw new ValidationError(`${title}: only a chart or table grouped by something can switch its grouping.`);
      if (options.drill) throw new ValidationError(`${title}: a chart that drills down can't switch its grouping too.`);
      if (query.breakdown) throw new ValidationError(`${title}: a chart with a second grouping can't switch its grouping.`);
      const types = new Map(columns.map((column) => [column.name, column.type]));
      const seen = new Set([`${query.groupBy.field}|${query.groupBy.grain ?? ""}`]);
      result.groupings = raw.groupings.map((entry, index) => {
        const grouping = (entry ?? {}) as Record<string, unknown>;
        const field = typeof grouping.field === "string" ? grouping.field : "";
        const type = types.get(field);
        if (!type) throw new ValidationError(`${title}: grouping ${index + 2} has no column called ${field || "that"}.`);
        const dated = type === "DATE" || type.startsWith("TIMESTAMP");
        const grains: Grain[] = ["day", "week", "month", "quarter", "year", "fquarter", "fyear"];
        const grain = dated ? (grains.includes(grouping.grain as Grain) ? (grouping.grain as Grain) : "month") : undefined;
        const key = `${field}|${grain ?? ""}`;
        if (seen.has(key)) throw new ValidationError(`${title}: each grouping the reader can choose should be different.`);
        seen.add(key);
        return { field, ...(grain ? { grain } : {}) };
      });
    }
  }
  return result.values || result.groupings?.length ? result : undefined;
}

/** A reader's choice on a tile, as sent: positions only. */
export function parseChoice(input: unknown): TileChoice | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const index = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) < 20 ? (value as number) : undefined);
  const value = index(raw.value);
  const grouping = index(raw.grouping);
  return value === undefined && grouping === undefined ? undefined : { ...(value !== undefined ? { value } : {}), ...(grouping !== undefined ? { grouping } : {}) };
}

/**
 * The tile's question with the reader's choice made: only one of its
 * saved values (a formula naming the tile's other values gets them as its
 * own inputs, so it still works alone), and one of its saved groupings. A
 * choice the tile doesn't offer is refused.
 */
export function applyChoice(query: TileQuery, switches: TileSwitches | undefined, choice: TileChoice | undefined): TileQuery {
  // A tile that shows one value at a time shows its first until the reader chooses another.
  const value = choice?.value ?? (switches?.values ? 0 : undefined);
  let result = query;
  if (value !== undefined) {
    if (!switches?.values || value >= query.measures.length) throw new ValidationError("That tile doesn't offer that value.");
    const chosen = query.measures[value];
    let alone: Measure = chosen;
    if (chosen.aggregate === "formula") {
      const { quick, period, compare } = chosen;
      alone = { ...measureFromSaved({ id: null, table: query.table, name: chosen.label, description: null, definition: definitionToSave(chosen, query.measures) }), ...(quick ? { quick } : {}), ...(period ? { period } : {}), ...(compare ? { compare } : {}) };
    }
    result = { ...result, measures: [alone] };
  }
  if (choice?.grouping !== undefined && choice.grouping > 0) {
    const grouping = switches?.groupings?.[choice.grouping - 1];
    if (!grouping) throw new ValidationError("That tile doesn't offer that grouping.");
    // Values that compare with last year need a date grouping; on another one they show without it.
    const dated = Boolean(grouping.grain);
    result = {
      ...result,
      groupBy: grouping,
      measures: result.measures.map((measure) => (measure.compare && !dated ? { ...measure, compare: undefined } : measure)),
      // Dates read oldest first, whatever the tile's own order.
      sort: dated ? { by: "category", direction: "asc" } : result.sort,
    };
  }
  return result;
}

/** The tile's format with the chosen value's settings first (a chart keeps its settings by position), so the chosen value looks as it does with the others. */
export function choiceFormat(format: ChartFormat | undefined, measures: Measure[], choice: TileChoice | undefined, switches?: TileSwitches): ChartFormat | undefined {
  const value = choice?.value ?? (switches?.values ? 0 : undefined);
  if (!format?.series || value === undefined || value >= measures.length) return format;
  const positions = measures.map((measure) => (measure.compare ? 2 : 1));
  const start = positions.slice(0, value).reduce((total, count) => total + count, 0);
  return { ...format, series: format.series.slice(start, start + positions[value]) };
}
