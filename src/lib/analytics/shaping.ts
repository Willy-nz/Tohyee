import { ValidationError } from "@/lib/errors";
import { DECIMAL_RESULT, decimalResultSql, exactAverageSql, exactDivideSql } from "@/lib/analytics/decimal-sql";
import { COLUMN_TYPES, type ColumnKind } from "@/lib/analytics/engine";
import { STEP_LABELS } from "@/lib/analytics/shaping-labels";
import { formulaKeepsMoney, formulaRefs, parseFormula, type FormulaNode } from "@/lib/analytics/formula";

export type ShapeColumn = { name: string; type: string };

type Operand = { type: "column"; name: string } | { type: "number"; value: string };
export type ShapeTest = "is" | "is not" | "contains" | "more than" | "at least" | "less than" | "at most" | "is empty" | "is not empty";
/** What a conditional column gives: another column's value, a typed-in value, or blank (null). */
export type ShapeOutput = { type: "column"; name: string } | { type: "value"; value: string } | { type: "blank" };
export type DatePart =
  | "year"
  | "quarter"
  | "month"
  | "month_name"
  | "week"
  | "day"
  | "day_of_week"
  | "day_name"
  | "financial_year"
  | "financial_quarter";
export type ShapeAggregate = "sum" | "average" | "count" | "smallest" | "largest";
export type ShapeStep =
  | { type: "filter"; column: string; test: ShapeTest; value?: string }
  | { type: "columns"; action: "keep" | "remove"; columns: string[] }
  | { type: "rename"; column: string; name: string }
  | { type: "type"; column: string; kind: ColumnKind }
  | { type: "split"; column: string; separator: string; names: string[] }
  /** `other`: Power Query's "Unpivot other columns": `columns` are kept and every other column is unpivoted. */
  | { type: "unpivot"; columns: string[]; attributeName: string; valueName: string; other?: true }
  | {
      type: "group";
      by: string[];
      aggregates: Array<{ operation: "sum" | "average" | "count" | "smallest" | "largest"; column?: string; name: string }>;
    }
  | {
      type: "calculated";
      name: string;
      expression:
        | { type: "arithmetic"; left: Operand; operator: "+" | "-" | "*" | "/"; right: Operand }
        | { type: "text"; parts: Array<{ type: "column"; name: string } | { type: "text"; value: string }> };
    }
  | { type: "merge"; table: string; join: "left" | "inner"; matches: Array<{ column: string; withColumn: string }>; columns: Array<{ column: string; name: string }> }
  | { type: "append"; table: string }
  // #376 phase 4 (decisions 790-797): Power Query's Pivot column, Fill, Replace values, Remove duplicates,
  // Conditional column, Date parts, Sort, Index column and Custom column.
  | { type: "pivot"; column: string; valueColumn: string; operation: ShapeAggregate; columns: Array<{ value: string; name: string }> }
  | { type: "fill"; columns: string[]; direction: "down" | "up" }
  /** `find: null` replaces blank cells. `match: "part"` (text only) replaces the text wherever it appears in a cell. */
  | { type: "replace"; columns: string[]; find: string | null; replaceWith: string | null; match: "whole" | "part" }
  | { type: "distinct"; columns: string[] }
  | {
      type: "conditional";
      name: string;
      rules: Array<{ column: string; test: ShapeTest; value?: string; then: ShapeOutput }>;
      otherwise: ShapeOutput;
      /** The new column's type; when left out it's worked out from the outputs. */
      kind?: ColumnKind;
    }
  | { type: "dateParts"; column: string; parts: Array<{ part: DatePart; name: string }> }
  | { type: "sort"; by: Array<{ column: string; descending: boolean }> }
  | { type: "index"; name: string; start: number; increment: number }
  | { type: "formula"; name: string; formula: string };

export const DATE_PARTS: readonly DatePart[] = [
  "year",
  "quarter",
  "month",
  "month_name",
  "week",
  "day",
  "day_of_week",
  "day_name",
  "financial_year",
  "financial_quarter",
];

const FILTER_TESTS = [
  "is",
  "is not",
  "contains",
  "more than",
  "at least",
  "less than",
  "at most",
  "is empty",
  "is not empty",
] as const;
const AGGREGATES = ["sum", "average", "count", "smallest", "largest"] as const;
// No DOUBLE or FLOAT: money and quantities stay exact (change a float column's type first).
const NUMBER_TYPE = /^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT)/;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(message);
  return value as Record<string, unknown>;
}

function text(value: unknown, message: string, max = 500): string {
  if (typeof value !== "string" || value.length > max) throw new ValidationError(message);
  return value;
}

function named(value: unknown, message: string): string {
  const name = text(value, message);
  if (!IDENTIFIER.test(name)) throw new ValidationError(`${message} Use lower-case letters, digits and underscores, starting with a letter.`);
  return name;
}

function names(value: unknown, message: string, minimum = 1): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100) throw new ValidationError(message);
  const result = value.map((entry) => named(entry, message));
  if (new Set(result).size !== result.length) throw new ValidationError(`${message} Choose each column only once.`);
  return result;
}

function parseOperand(value: unknown): Operand {
  const raw = object(value, "A calculation needs a column or a number.");
  if (raw.type === "column") return { type: "column", name: named(raw.name, "Choose a column.") };
  if (raw.type === "number" && typeof raw.value === "string" && NUMBER_TEXT.test(raw.value)) {
    return { type: "number", value: raw.value };
  }
  throw new ValidationError("A calculation needs a column or a valid number.");
}

function parseOutput(value: unknown, where: string): ShapeOutput {
  const raw = object(value, `${where}: choose what the new column gives.`);
  if (raw.type === "column") return { type: "column", name: named(raw.name, "Choose a column.") };
  if (raw.type === "value") return { type: "value", value: text(raw.value, `${where}: enter a value.`) };
  if (raw.type === "blank") return { type: "blank" };
  throw new ValidationError(`${where}: give a column, a value or blank.`);
}

function usesDays(node: FormulaNode): boolean {
  if (node.kind === "days") return true;
  if (node.kind === "negate") return usesDays(node.operand);
  if (node.kind === "binary") return usesDays(node.left) || usesDays(node.right);
  return false;
}

// Each merge or append can multiply the rows, so a shape has only a few.
const MAX_JOINS = 5;

export function parseShapeSteps(value: unknown): ShapeStep[] {
  if (!Array.isArray(value) || value.length > 100) throw new ValidationError("Steps must be a list of up to 100 steps.");
  const steps = parseEachStep(value);
  if (steps.filter((step) => step.type === "merge" || step.type === "append").length > MAX_JOINS) {
    throw new ValidationError(`A shaped table can have at most ${MAX_JOINS} merge and append steps.`);
  }
  return steps;
}

function parseEachStep(value: unknown[]): ShapeStep[] {
  return value.map((entry, index) => {
    const raw = object(entry, `Step ${index + 1} isn't set up properly.`);
    const fail = (message: string): never => {
      throw new ValidationError(`Step ${index + 1}: ${message}`);
    };
    switch (raw.type) {
      case "filter": {
        if (!FILTER_TESTS.includes(raw.test as (typeof FILTER_TESTS)[number])) return fail("choose a test.");
        const step: ShapeStep & { type: "filter" } = {
          type: "filter",
          column: named(raw.column, "Choose a column."),
          test: raw.test as (typeof FILTER_TESTS)[number],
        };
        if (step.test !== "is empty" && step.test !== "is not empty") step.value = text(raw.value, "Enter a filter value.");
        return step;
      }
      case "columns":
        if (raw.action !== "keep" && raw.action !== "remove") return fail("choose whether to keep or remove columns.");
        return { type: "columns", action: raw.action, columns: names(raw.columns, "Choose one or more columns.") };
      case "rename":
        return { type: "rename", column: named(raw.column, "Choose a column."), name: named(raw.name, "Enter a valid new column name.") };
      case "type":
        if (typeof raw.kind !== "string" || !Object.hasOwn(COLUMN_TYPES, raw.kind)) return fail("choose a column type.");
        return { type: "type", column: named(raw.column, "Choose a column."), kind: raw.kind as ColumnKind };
      case "split":
        return {
          type: "split",
          column: named(raw.column, "Choose a column."),
          separator: text(raw.separator, "Enter a separator.", 100),
          names: names(raw.names, "Enter at least two new column names.", 2),
        };
      case "unpivot": {
        if (raw.other !== undefined && raw.other !== true) return fail("choose whether to unpivot the chosen columns or the other columns.");
        const step: ShapeStep & { type: "unpivot" } = {
          type: "unpivot",
          columns: raw.other ? names(raw.columns, "Choose the columns to keep.") : names(raw.columns, "Choose at least two columns to unpivot.", 2),
          attributeName: named(raw.attributeName, "Enter a valid attribute column name."),
          valueName: named(raw.valueName, "Enter a valid value column name."),
        };
        if (raw.other) step.other = true;
        return step;
      }
      case "group": {
        if (!Array.isArray(raw.aggregates) || raw.aggregates.length === 0 || raw.aggregates.length > 100) return fail("add at least one total, average, count, smallest or largest.");
        const by = raw.by === undefined ? [] : names(raw.by, "Choose group columns.");
        const aggregates = raw.aggregates.map((item, aggregateIndex) => {
          const aggregate = object(item, `Aggregate ${aggregateIndex + 1} isn't set up properly.`);
          if (!AGGREGATES.includes(aggregate.operation as (typeof AGGREGATES)[number])) {
            throw new ValidationError(`Step ${index + 1}: choose an aggregate.`);
          }
          const operation = aggregate.operation as (typeof AGGREGATES)[number];
          const name = named(aggregate.name, "Enter a valid result column name.");
          const column = aggregate.column === undefined ? undefined : named(aggregate.column, "Choose a column.");
          if (operation !== "count" && !column) throw new ValidationError(`Step ${index + 1}: ${operation} needs a column.`);
          if (operation === "count" && !column) return { operation, name };
          return { operation, name, column };
        });
        if (new Set([...by, ...aggregates.map((aggregate) => aggregate.name)]).size !== by.length + aggregates.length) {
          return fail("group and result columns must have different names.");
        }
        return { type: "group", by, aggregates };
      }
      case "calculated": {
        const name = named(raw.name, "Enter a valid calculated column name.");
        const expression = object(raw.expression, "Set up the calculation.");
        if (expression.type === "arithmetic") {
          if (!["+", "-", "*", "/"].includes(String(expression.operator))) return fail("choose +, -, * or /.");
          return {
            type: "calculated",
            name,
            expression: {
              type: "arithmetic",
              left: parseOperand(expression.left),
              operator: expression.operator as "+" | "-" | "*" | "/",
              right: parseOperand(expression.right),
            },
          };
        }
        if (expression.type === "text" && Array.isArray(expression.parts) && expression.parts.length > 0 && expression.parts.length <= 100) {
          const parts = expression.parts.map((part) => {
            const rawPart = object(part, "Text calculations use columns or literal text.");
            if (rawPart.type === "column") return { type: "column" as const, name: named(rawPart.name, "Choose a column.") };
            if (rawPart.type === "text") return { type: "text" as const, value: text(rawPart.value, "Enter text.", 500) };
            throw new ValidationError("Text calculations use columns or literal text.");
          });
          return { type: "calculated", name, expression: { type: "text", parts } };
        }
        return fail("choose a number calculation or joined text.");
      }
      case "merge": {
        if (raw.join !== "left" && raw.join !== "inner") return fail("choose a left or inner join.");
        if (!Array.isArray(raw.matches) || raw.matches.length === 0 || raw.matches.length > 20) return fail("choose at least one matching column.");
        if (!Array.isArray(raw.columns) || raw.columns.length > 100) return fail("choose columns to bring in.");
        const matches = raw.matches.map((item) => {
          const match = object(item, "Choose matching columns.");
          return { column: named(match.column, "Choose a column."), withColumn: named(match.withColumn, "Choose a matching column.") };
        });
        const columns = raw.columns.map((item) => {
          const column = object(item, "Choose columns to bring in.");
          return { column: named(column.column, "Choose a column."), name: named(column.name, "Enter a valid output column name.") };
        });
        return { type: "merge", table: named(raw.table, "Choose a table."), join: raw.join, matches, columns };
      }
      case "append":
        return { type: "append", table: named(raw.table, "Choose a table.") };
      case "pivot": {
        if (!AGGREGATES.includes(raw.operation as ShapeAggregate)) return fail("choose how to combine the values.");
        if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > 100) return fail("add at least one value to make a column for (up to 100).");
        const columns = raw.columns.map((item) => {
          const entry = object(item, `Step ${index + 1}: each new column needs a value and a name.`);
          return { value: text(entry.value, `Step ${index + 1}: enter the value for each new column.`, 200), name: named(entry.name, "Enter a valid new column name.") };
        });
        if (new Set(columns.map((entry) => entry.name)).size !== columns.length) return fail("give each new column its own name.");
        if (new Set(columns.map((entry) => entry.value)).size !== columns.length) return fail("list each value only once.");
        return {
          type: "pivot",
          column: named(raw.column, "Choose the column whose values become columns."),
          valueColumn: named(raw.valueColumn, "Choose the values column."),
          operation: raw.operation as ShapeAggregate,
          columns,
        };
      }
      case "fill":
        if (raw.direction !== "down" && raw.direction !== "up") return fail("choose to fill down or up.");
        return { type: "fill", columns: names(raw.columns, "Choose one or more columns to fill."), direction: raw.direction };
      case "replace": {
        if (raw.match !== "whole" && raw.match !== "part") return fail("choose whether to match whole cells or part of the text.");
        const find = raw.find === null ? null : text(raw.find, "Enter the value to find.", 500);
        const replaceWith = raw.replaceWith === null ? null : text(raw.replaceWith, "Enter the value to replace it with.", 500);
        if (raw.match === "part" && !find) return fail("enter the text to find.");
        return { type: "replace", columns: names(raw.columns, "Choose one or more columns."), find, replaceWith, match: raw.match };
      }
      case "distinct":
        return { type: "distinct", columns: names(raw.columns, "Choose the columns that make a row a duplicate.") };
      case "conditional": {
        if (!Array.isArray(raw.rules) || raw.rules.length === 0 || raw.rules.length > 50) return fail("add at least one rule (up to 50).");
        const rules = raw.rules.map((item, ruleIndex) => {
          const rule = object(item, `Step ${index + 1}: rule ${ruleIndex + 1} isn't set up properly.`);
          if (!FILTER_TESTS.includes(rule.test as ShapeTest)) throw new ValidationError(`Step ${index + 1}: rule ${ruleIndex + 1} needs a test.`);
          const parsed: { column: string; test: ShapeTest; value?: string; then: ShapeOutput } = {
            column: named(rule.column, "Choose a column."),
            test: rule.test as ShapeTest,
            then: parseOutput(rule.then, `Step ${index + 1}: rule ${ruleIndex + 1}`),
          };
          if (parsed.test !== "is empty" && parsed.test !== "is not empty") parsed.value = text(rule.value, `Step ${index + 1}: rule ${ruleIndex + 1} needs a value to compare with.`);
          return parsed;
        });
        const step: ShapeStep & { type: "conditional" } = {
          type: "conditional",
          name: named(raw.name, "Enter a valid new column name."),
          rules,
          otherwise: parseOutput(raw.otherwise, `Step ${index + 1}: otherwise`),
        };
        if (raw.kind !== undefined) {
          if (typeof raw.kind !== "string" || !Object.hasOwn(COLUMN_TYPES, raw.kind)) return fail("choose a column type.");
          step.kind = raw.kind as ColumnKind;
        }
        return step;
      }
      case "dateParts": {
        if (!Array.isArray(raw.parts) || raw.parts.length === 0 || raw.parts.length > DATE_PARTS.length) return fail("choose one or more date parts.");
        const parts = raw.parts.map((item) => {
          const entry = object(item, `Step ${index + 1}: each date part needs a part and a name.`);
          if (!DATE_PARTS.includes(entry.part as DatePart)) throw new ValidationError(`Step ${index + 1}: choose a date part.`);
          return { part: entry.part as DatePart, name: named(entry.name, "Enter a valid new column name.") };
        });
        if (new Set(parts.map((entry) => entry.name)).size !== parts.length) return fail("give each date part its own column name.");
        return { type: "dateParts", column: named(raw.column, "Choose a date column."), parts };
      }
      case "sort": {
        if (!Array.isArray(raw.by) || raw.by.length === 0 || raw.by.length > 10) return fail("choose one or more columns to sort by (up to 10).");
        const by = raw.by.map((item) => {
          const entry = object(item, `Step ${index + 1}: choose a column to sort by.`);
          if (entry.descending !== undefined && typeof entry.descending !== "boolean") throw new ValidationError(`Step ${index + 1}: choose ascending or descending.`);
          return { column: named(entry.column, "Choose a column."), descending: entry.descending === true };
        });
        if (new Set(by.map((entry) => entry.column)).size !== by.length) return fail("sort by each column only once.");
        return { type: "sort", by };
      }
      case "index": {
        const whole = (value: unknown, what: string) => {
          if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000) throw new ValidationError(`Step ${index + 1}: ${what} must be a whole number.`);
          return value;
        };
        const increment = raw.increment === undefined ? 1 : whole(raw.increment, "the increment");
        if (increment === 0) return fail("the increment can't be 0.");
        return { type: "index", name: named(raw.name, "Enter a valid index column name."), start: raw.start === undefined ? 1 : whole(raw.start, "the start"), increment };
      }
      case "formula": {
        const formula = text(raw.formula, "Enter a formula, e.g. [amount] * 1.15.", 500).trim();
        const tree = parseFormula(formula);
        if (usesDays(tree)) return fail("days only works in a report's values. Use columns, numbers, + - * / and brackets.");
        return { type: "formula", name: named(raw.name, "Enter a valid new column name."), formula };
      }
      default:
        return fail("choose a supported shaping step.");
    }
  });
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function requireColumn(columns: Map<string, string>, name: string): string {
  if (!columns.has(name)) throw new ValidationError(`There's no column called ${name} at this step.`);
  return name;
}

function ensureUnused(columns: Map<string, string>, namesToAdd: string[]): void {
  if (new Set(namesToAdd).size !== namesToAdd.length || namesToAdd.some((name) => columns.has(name))) {
    throw new ValidationError("A new column name is already in use.");
  }
}

function tableColumns(tables: Map<string, ShapeColumn[]>, name: string): Map<string, string> {
  const columns = tables.get(name);
  if (!columns) throw new ValidationError(`There's no loaded table called ${name}.`);
  return new Map(columns.map((column) => [column.name, column.type]));
}

function numeric(type: string): boolean {
  return NUMBER_TYPE.test(type);
}

function comparisonType(type: string): string {
  if (
    /^(?:DECIMAL\(\d+,\d+\)|VARCHAR|BOOLEAN|DATE|TIMESTAMP(?: WITH TIME ZONE)?|(?:U)?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|DOUBLE|FLOAT)$/.test(
      type,
    )
  ) {
    return type;
  }
  return "VARCHAR";
}

const MONEY_TYPE = /^DECIMAL\(\d+,2\)$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?$/;
const INTEGER_TYPE = /^(BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT)$/;

function validDate(value: string): boolean {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}

/**
 * A typed-in value for a column of `type`, checked here so a mistake is
 * explained before anything runs: a number with more decimal places than
 * the column keeps is refused rather than rounded (money stays exact).
 */
function literalSql(type: string, value: string, what: string, param: (value: unknown) => string): string {
  const scale = /^DECIMAL\(\d+,(\d+)\)$/.exec(type);
  if (scale || INTEGER_TYPE.test(type)) {
    if (!NUMBER_TEXT.test(value)) throw new ValidationError(`${what}: ${value || "a blank"} isn't a number. Use digits, a leading - and a decimal point (no commas or $).`);
    const places = value.split(".")[1]?.length ?? 0;
    if (places > (scale ? Number(scale[1]) : 0)) {
      throw new ValidationError(`${what}: ${value} has more decimal places than the column keeps (${scale ? scale[1] : "0"}), so it would be rounded.`);
    }
  } else if (type === "DATE") {
    if (!DATE_TEXT.test(value) || !validDate(value)) throw new ValidationError(`${what}: enter a date as YYYY-MM-DD.`);
  } else if (type.startsWith("TIMESTAMP")) {
    if (!TIMESTAMP_TEXT.test(value) || !validDate(value)) throw new ValidationError(`${what}: enter a date and time as YYYY-MM-DD HH:MM.`);
  } else if (type === "BOOLEAN") {
    if (value !== "true" && value !== "false") throw new ValidationError(`${what}: enter true or false.`);
  } else if (type !== "VARCHAR") {
    throw new ValidationError(`${what}: values of type ${type} can't be typed in. Change the column's type first.`);
  }
  return `cast(${param(value)} as ${type})`;
}

/** A filter test, as SQL, on a column at this step (shared by Filter rows and Conditional column). */
function testSql(
  columns: Map<string, string>,
  test: { column: string; test: ShapeTest; value?: string },
  param: (value: unknown) => string,
): string {
  const column = requireColumn(columns, test.column);
  const field = quote(column);
  if (test.test === "is empty") return `(${field} is null or cast(${field} as varchar) = '')`;
  if (test.test === "is not empty") return `(${field} is not null and cast(${field} as varchar) <> '')`;
  const value = `cast(${param(test.value ?? "")} as ${comparisonType(columns.get(column)!)})`;
  return {
    is: `${field} = ${value}`,
    "is not": `${field} <> ${value}`,
    contains: `contains(lower(cast(${field} as varchar)), lower(${value}))`,
    "more than": `${field} > ${value}`,
    "at least": `${field} >= ${value}`,
    "less than": `${field} < ${value}`,
    "at most": `${field} <= ${value}`,
  }[test.test];
}

/** The type a sum of a number column comes out as in DuckDB. */
function sumType(type: string): string {
  const decimal = /^DECIMAL\(\d+,(\d+)\)$/.exec(type);
  return decimal ? `DECIMAL(38,${decimal[1]})` : "HUGEINT";
}

/** Column names Tohyee uses inside a step; a column's name starts with a letter, so these can't clash. */
const ROW = quote("_tohyee_row");

/**
 * What a Merge step must be checked for before it runs (#387, decision
 * 693), worked out by `mergeCheckSql` from the rows themselves:
 * - the other table must have at most one row for each match, or every
 *   matching row here would be repeated and its amounts counted again (one
 *   invoice of 100.00 merged with its three lines would become 300.00);
 * - when this table has several rows for one match (many lines to one
 *   invoice), only text, dates and Yes/No can be brought in: a number from
 *   the other table would repeat on each row and add up more than once;
 * - rows with no match are counted, to say what happened to them.
 */
export type MergeCheck = {
  step: number;
  table: string;
  join: "left" | "inner";
  /** This table's match columns and the other table's, in order. */
  columns: string[];
  withColumns: string[];
  /** The numbers brought in (by their new names). */
  numbers: string[];
  /** The rows before the merge, as a CTE name in `sql`. */
  source: string;
};

export function buildShapeQuery(input: {
  baseTable: string;
  tables: Map<string, ShapeColumn[]>;
  steps: unknown;
  throughStep?: number;
  /** The organisation's balance date month (1-12), for financial years in Date parts. 31 March when not given. */
  yearEndMonth?: number;
}): { sql: string; params: unknown[]; columns: ShapeColumn[]; merges: MergeCheck[]; ctes: string; steps: number } {
  const parsed = parseShapeSteps(input.steps);
  if (!input.tables.has(input.baseTable)) throw new ValidationError(`There's no loaded table called ${input.baseTable}.`);
  if (input.throughStep !== undefined && (!Number.isInteger(input.throughStep) || input.throughStep < 0 || input.throughStep >= parsed.length)) {
    throw new ValidationError("Choose a step to preview.");
  }
  const steps = input.throughStep === undefined ? parsed : parsed.slice(0, input.throughStep + 1);
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const ctes = [`shape0 as (select * from ${quote(input.baseTable)})`];
  let source = "shape0";
  let columns = tableColumns(input.tables, input.baseTable);

  const merges: MergeCheck[] = [];
  const yearEndMonth = Number.isInteger(input.yearEndMonth) && input.yearEndMonth! >= 1 && input.yearEndMonth! <= 12 ? input.yearEndMonth! : 3;
  /**
   * Whether the rows still have a set order (decision 793): the order they
   * were loaded in, or a Sort step's. DuckDB keeps it through steps that
   * keep or drop rows; grouping, pivoting, merging and appending don't, so
   * a step that needs an order (Fill, Index column) after one of those
   * needs a Sort step first.
   */
  let unorderedBy: string | null = null;
  const needsOrder = (index: number) => {
    if (unorderedBy) {
      throw new ValidationError(`Step ${index + 1} needs the rows in order, but after ${unorderedBy} they have none. Add a Sort step before step ${index + 1}.`);
    }
  };
  const selected = (current: Map<string, string>) => [...current.keys()].map((name) => quote(name)).join(", ");
  const checkedNames = (current: Map<string, string>, value: string[]) => value.map((name) => requireColumn(current, name));

  steps.forEach((step, index) => {
    const next = `shape${index + 1}`;
    let sql: string;
    switch (step.type) {
      case "filter":
        sql = `select * from ${source} where ${testSql(columns, step, param)}`;
        break;
      case "columns": {
        const chosen = checkedNames(columns, step.columns);
        const retained = step.action === "keep" ? chosen : [...columns.keys()].filter((name) => !chosen.includes(name));
        if (retained.length === 0) throw new ValidationError("A shaping step must leave at least one column.");
        columns = new Map(retained.map((name) => [name, columns.get(name)!]));
        sql = `select ${selected(columns)} from ${source}`;
        break;
      }
      case "rename": {
        requireColumn(columns, step.column);
        ensureUnused(new Map([...columns].filter(([name]) => name !== step.column)), [step.name]);
        const original = [...columns];
        columns = new Map(original.map(([name, type]) => [name === step.column ? step.name : name, type]));
        sql = `select ${original.map(([name]) => `${quote(name)} as ${quote(name === step.column ? step.name : name)}`).join(", ")} from ${source}`;
        break;
      }
      case "type": {
        requireColumn(columns, step.column);
        columns.set(step.column, COLUMN_TYPES[step.kind]);
        sql = `select ${[...columns.keys()].map((name) => name === step.column ? `cast(${quote(name)} as ${COLUMN_TYPES[step.kind]}) as ${quote(name)}` : quote(name)).join(", ")} from ${source}`;
        break;
      }
      case "split": {
        requireColumn(columns, step.column);
        if (!step.separator) throw new ValidationError("Enter a separator to split on.");
        const newNames = step.names;
        ensureUnused(new Map([...columns].filter(([name]) => name !== step.column)), newNames);
        const separator = param(step.separator);
        const retained = [...columns].filter(([name]) => name !== step.column);
        const parts = step.names.map((name, i) => [`split_part(cast(${quote(step.column)} as varchar), ${separator}, ${i + 1})`, name] as const);
        columns = new Map([...retained, ...parts.map((part) => [part[1], "VARCHAR"] as const)]);
        sql = `select ${[...retained.map(([name]) => quote(name)), ...parts.map(([expression, name]) => `${expression} as ${quote(name)}`)].join(", ")} from ${source}`;
        break;
      }
      case "unpivot": {
        const listed = checkedNames(columns, step.columns);
        const chosen = step.other ? [...columns.keys()].filter((name) => !listed.includes(name)) : listed;
        if (chosen.length === 0) throw new ValidationError("There are no other columns to unpivot.");
        const remaining = [...columns].filter(([name]) => !chosen.includes(name));
        ensureUnused(new Map(remaining), [step.attributeName, step.valueName]);
        if (step.attributeName === step.valueName) throw new ValidationError("The unpivot output columns must have different names.");
        const types = chosen.map((name) => columns.get(name)!);
        const valueType = types.every((type) => type === types[0]) ? types[0] : "VARCHAR";
        // DuckDB refuses to unpivot text with numbers or dates, so mixed columns become text first.
        // Mixed number columns are left to DuckDB as before (it finds a number type for them).
        const asText = valueType === "VARCHAR" && !types.every((type) => numeric(type));
        const from = asText
          ? `(select ${[...columns.keys()].map((name) => (chosen.includes(name) ? `cast(${quote(name)} as VARCHAR) as ${quote(name)}` : quote(name))).join(", ")} from ${source})`
          : source;
        columns = new Map([...remaining, [step.attributeName, "VARCHAR"], [step.valueName, valueType]]);
        sql = `select * from ${from} unpivot (${quote(step.valueName)} for ${quote(step.attributeName)} in (${chosen.map(quote).join(", ")}))`;
        break;
      }
      case "group": {
        const by = checkedNames(columns, step.by);
        const aggregateSql = step.aggregates.map((aggregate) => {
          const column = aggregate.column ? requireColumn(columns, aggregate.column) : null;
          if (["sum", "average"].includes(aggregate.operation) && (!column || !numeric(columns.get(column)!))) {
            throw new ValidationError(`${aggregate.name} needs a number column.`);
          }
          const expression = column ? quote(column) : "*";
          const fn = { sum: "sum", average: "avg", count: "count", smallest: "min", largest: "max" }[aggregate.operation];
          const result = aggregate.operation === "average" ? exactAverageSql(expression) : `${fn}(${expression})`;
          return { name: aggregate.name, type: aggregate.operation === "average" ? "DECIMAL(38,6)" : aggregate.operation === "count" ? "BIGINT" : column ? columns.get(column)! : "BIGINT", sql: `${result} as ${quote(aggregate.name)}` };
        });
        ensureUnused(new Map(by.map((name) => [name, columns.get(name)!])), aggregateSql.map((aggregate) => aggregate.name));
        columns = new Map([...by.map((name) => [name, columns.get(name)!] as const), ...aggregateSql.map(({ name, type }) => [name, type] as const)]);
        sql = `select ${[...by.map(quote), ...aggregateSql.map((aggregate) => aggregate.sql)].join(", ")} from ${source}${by.length ? ` group by ${by.map(quote).join(", ")}` : ""}`;
        break;
      }
      case "calculated": {
        ensureUnused(columns, [step.name]);
        let expression: string;
        let resultType = "VARCHAR";
        if (step.expression.type === "arithmetic") {
          const operand = (item: Operand) => {
            if (item.type === "number") return `cast(${param(item.value)} as DECIMAL(38,6))`;
            const name = requireColumn(columns, item.name);
            if (!numeric(columns.get(name)!)) throw new ValidationError(`${name} isn't a number.`);
            return quote(name);
          };
          const left = operand(step.expression.left);
          const right = operand(step.expression.right);
          // Exact: DuckDB would divide decimals as DOUBLE, and products grow their scale.
          expression = step.expression.operator === "/" ? exactDivideSql(left, right) : decimalResultSql(`(${left} ${step.expression.operator} ${right})`);
          resultType = DECIMAL_RESULT;
        } else {
          const parts = step.expression.parts.map((part) => {
            if (part.type === "text") return param(part.value);
            const name = requireColumn(columns, part.name);
            return `coalesce(cast(${quote(name)} as varchar), '')`;
          });
          expression = `concat(${parts.join(", ")})`;
        }
        columns.set(step.name, resultType);
        sql = `select *, ${expression} as ${quote(step.name)} from ${source}`;
        break;
      }
      case "merge": {
        const right = tableColumns(input.tables, step.table);
        const matches = step.matches.map((match) => {
          requireColumn(columns, match.column);
          requireColumn(right, match.withColumn);
          return `${quote("left_source")}.${quote(match.column)} = ${quote("right_source")}.${quote(match.withColumn)}`;
        });
        const additions = step.columns.map(({ column, name }) => {
          requireColumn(right, column);
          return { column, name };
        });
        ensureUnused(columns, additions.map(({ name }) => name));
        merges.push({
          step: index + 1,
          table: step.table,
          join: step.join,
          columns: step.matches.map((match) => match.column),
          withColumns: step.matches.map((match) => match.withColumn),
          numbers: additions.filter(({ column }) => NUMBER_TYPE.test(right.get(column)!) || /^(DOUBLE|FLOAT)/.test(right.get(column)!)).map(({ column }) => column),
          source,
        });
        columns = new Map([...columns, ...additions.map(({ column, name }) => [name, right.get(column)!] as const)]);
        sql = `select ${[...[...columns.keys()].filter((name) => !additions.some((entry) => entry.name === name)).map((name) => `${quote("left_source")}.${quote(name)} as ${quote(name)}`), ...additions.map(({ column, name }) => `${quote("right_source")}.${quote(column)} as ${quote(name)}`)].join(", ")} from ${source} as ${quote("left_source")} ${step.join === "left" ? "left" : "inner"} join ${quote(step.table)} as ${quote("right_source")} on ${matches.join(" and ")}`;
        break;
      }
      case "append": {
        const right = tableColumns(input.tables, step.table);
        const merged = new Map(columns);
        for (const [name, type] of right) if (!merged.has(name)) merged.set(name, type);
        const leftProjection = [...merged.keys()].map((name) =>
          columns.has(name) ? quote(name) : `null as ${quote(name)}`,
        );
        const rightProjection = [...merged.keys()].map((name) =>
          right.has(name) ? quote(name) : `null as ${quote(name)}`,
        );
        columns = merged;
        sql = `select ${leftProjection.join(", ")} from ${source} union all by name select ${rightProjection.join(", ")} from ${quote(step.table)}`;
        break;
      }
      case "pivot": {
        const attribute = requireColumn(columns, step.column);
        const value = requireColumn(columns, step.valueColumn);
        if (attribute === value) throw new ValidationError("Choose a different column for the values.");
        const valueType = columns.get(value)!;
        if ((step.operation === "sum" || step.operation === "average") && !numeric(valueType)) {
          throw new ValidationError(`${value} isn't a number, so it can't be added up or averaged. Count it, or take the smallest or largest.`);
        }
        const others = [...columns.keys()].filter((name) => name !== attribute && name !== value);
        ensureUnused(new Map(others.map((name) => [name, columns.get(name)!])), step.columns.map((entry) => entry.name));
        const made = step.columns.map((entry) => {
          const match = `cast(${quote(attribute)} as VARCHAR) = ${param(entry.value)}`;
          const picked = `case when ${match} then ${quote(value)} end`;
          const fn = {
            sum: `sum(${picked})`,
            average: exactAverageSql(picked),
            count: `count(case when ${match} then 1 end)`,
            smallest: `min(${picked})`,
            largest: `max(${picked})`,
          }[step.operation];
          const type = { sum: sumType(valueType), average: DECIMAL_RESULT, count: "BIGINT", smallest: valueType, largest: valueType }[step.operation];
          return { name: entry.name, type, sql: `${fn} as ${quote(entry.name)}` };
        });
        columns = new Map([...others.map((name) => [name, columns.get(name)!] as const), ...made.map(({ name, type }) => [name, type] as const)]);
        sql = `select ${[...others.map(quote), ...made.map((entry) => entry.sql)].join(", ")} from ${source}${others.length ? ` group by ${others.map(quote).join(", ")}` : ""}`;
        break;
      }
      case "fill": {
        needsOrder(index);
        const chosen = checkedNames(columns, step.columns);
        // Like Power Query, only blank cells are filled; here an empty text cell counts as blank too, as in Filter rows.
        const filled = (name: string) => {
          const field = quote(name);
          const blankable = columns.get(name) === "VARCHAR" ? `nullif(${field}, '')` : field;
          const window = step.direction === "down"
            ? `last_value(${blankable} ignore nulls) over (order by ${ROW} rows between unbounded preceding and current row)`
            : `first_value(${blankable} ignore nulls) over (order by ${ROW} rows between current row and unbounded following)`;
          return `coalesce(${window}, ${field}) as ${field}`;
        };
        sql = `select ${[...columns.keys()].map((name) => (chosen.includes(name) ? filled(name) : quote(name))).join(", ")} from (select *, row_number() over () as ${ROW} from ${source}) order by ${ROW}`;
        break;
      }
      case "replace": {
        const chosen = checkedNames(columns, step.columns);
        const replaced = (name: string) => {
          const field = quote(name);
          const type = columns.get(name)!;
          const what = `Replace values in ${name}`;
          const replacement = step.replaceWith === null ? `cast(null as ${type})` : step.replaceWith === "" && type === "VARCHAR" ? "''" : literalSql(type, step.replaceWith, what, param);
          if (step.match === "part") {
            if (type !== "VARCHAR") throw new ValidationError(`${what}: only text columns can have part of a cell replaced. Match whole cells instead.`);
            return `replace(${field}, ${param(step.find)}, ${step.replaceWith === null ? "''" : replacement})`;
          }
          if (step.find === null) return `coalesce(${field}, ${replacement})`;
          if (step.find === "" && type === "VARCHAR") return `case when ${field} = '' then ${replacement} else ${field} end`;
          return `case when ${field} = ${literalSql(type, step.find, what, param)} then ${replacement} else ${field} end`;
        };
        sql = `select ${[...columns.keys()].map((name) => (chosen.includes(name) ? `${replaced(name)} as ${quote(name)}` : quote(name))).join(", ")} from ${source}`;
        break;
      }
      case "distinct": {
        const keys = checkedNames(columns, step.columns);
        // The first row of each set is kept (Power Query's Remove duplicates). With no set order, "first" is by every column, so it's the same row each time.
        const numbered = unorderedBy
          ? `row_number() over (order by ${[...columns.keys()].map((name) => `${quote(name)} nulls first`).join(", ")})`
          : "row_number() over ()";
        sql = `select ${selected(columns)} from (select *, ${numbered} as ${ROW} from ${source}) qualify row_number() over (partition by ${keys.map(quote).join(", ")} order by ${ROW}) = 1 order by ${ROW}`;
        break;
      }
      case "conditional": {
        ensureUnused(columns, [step.name]);
        const outputs = [...step.rules.map((rule) => rule.then), step.otherwise];
        const columnTypes = [...new Set(outputs.flatMap((output) => (output.type === "column" ? [columns.get(requireColumn(columns, output.name))!] : [])))];
        let resultType: string;
        if (step.kind) resultType = COLUMN_TYPES[step.kind];
        else if (columnTypes.length === 0) resultType = "VARCHAR";
        else if (columnTypes.length === 1) resultType = columnTypes[0];
        else if (columnTypes.every((type) => numeric(type))) resultType = columnTypes.every((type) => MONEY_TYPE.test(type)) ? "DECIMAL(38,2)" : DECIMAL_RESULT;
        else resultType = "VARCHAR";
        const outputSql = (output: ShapeOutput, where: string) => {
          if (output.type === "blank") return `cast(null as ${resultType})`;
          if (output.type === "column") return columns.get(output.name) === resultType ? quote(output.name) : `cast(${quote(output.name)} as ${resultType})`;
          return literalSql(resultType, output.value, `${step.name} (${where})`, param);
        };
        const whens = step.rules.map((rule, ruleIndex) => `when ${testSql(columns, rule, param)} then ${outputSql(rule.then, `rule ${ruleIndex + 1}`)}`);
        columns.set(step.name, resultType);
        sql = `select *, case ${whens.join(" ")} else ${outputSql(step.otherwise, "otherwise")} end as ${quote(step.name)} from ${source}`;
        break;
      }
      case "dateParts": {
        const column = requireColumn(columns, step.column);
        const type = columns.get(column)!;
        if (type !== "DATE" && !type.startsWith("TIMESTAMP")) throw new ValidationError(`${column} isn't a date. Change its type to a date first.`);
        ensureUnused(columns, step.parts.map((entry) => entry.name));
        const field = quote(column);
        // The financial year is named by the year it ends in (the year to 31 March 2026 is 2026), from the balance date.
        const shift = (12 - yearEndMonth) % 12;
        const shifted = shift ? `(${field} + interval ${shift} month)` : field;
        const partSql: Record<DatePart, [string, string]> = {
          year: [`year(${field})`, "BIGINT"],
          quarter: [`quarter(${field})`, "BIGINT"],
          month: [`month(${field})`, "BIGINT"],
          month_name: [`monthname(${field})`, "VARCHAR"],
          week: [`weekofyear(${field})`, "BIGINT"],
          day: [`day(${field})`, "BIGINT"],
          day_of_week: [`isodow(${field})`, "BIGINT"],
          day_name: [`dayname(${field})`, "VARCHAR"],
          financial_year: [`year(${shifted})`, "BIGINT"],
          financial_quarter: [`quarter(${shifted})`, "BIGINT"],
        };
        const parts = step.parts.map((entry) => ({ name: entry.name, sql: partSql[entry.part][0], type: partSql[entry.part][1] }));
        for (const part of parts) columns.set(part.name, part.type);
        sql = `select *, ${parts.map((part) => `${part.sql} as ${quote(part.name)}`).join(", ")} from ${source}`;
        break;
      }
      case "sort": {
        // As in Power Query, blanks come first going up and last going down.
        const order = step.by.map((entry) => `${quote(requireColumn(columns, entry.column))} ${entry.descending ? "desc nulls last" : "asc nulls first"}`);
        sql = `select * from ${source} order by ${order.join(", ")}`;
        break;
      }
      case "index": {
        needsOrder(index);
        ensureUnused(columns, [step.name]);
        columns.set(step.name, "BIGINT");
        sql = `select *, cast(${step.start} + (row_number() over () - 1) * ${step.increment} as BIGINT) as ${quote(step.name)} from ${source}`;
        break;
      }
      case "formula": {
        ensureUnused(columns, [step.name]);
        const tree = parseFormula(step.formula);
        for (const name of formulaRefs(tree)) {
          if (!columns.has(name)) throw new ValidationError(`${step.name}: there's no column called [${name}] at this step.`);
          if (!numeric(columns.get(name)!)) throw new ValidationError(`${step.name}: [${name}] isn't a number. A formula works with number columns.`);
        }
        // Exact, as in report formulas (decision 597): every part is DECIMAL(38,6) and division is done in millionths.
        // Unlike a report value, a blank cell gives a blank answer (Power Query's null), not 0.
        const decimal = (sql: string) => `cast(${sql} as ${DECIMAL_RESULT})`;
        const compile = (node: FormulaNode): string => {
          switch (node.kind) {
            case "number":
              return decimal(param(node.value));
            case "ref":
              return decimal(quote(node.name));
            case "days":
              throw new ValidationError(`${step.name}: days only works in a report's values.`);
            case "negate":
              return `(-(${compile(node.operand)}))`;
            case "binary":
              return node.op === "/" ? exactDivideSql(compile(node.left), compile(node.right)) : decimal(`(${compile(node.left)} ${node.op} ${compile(node.right)})`);
          }
        };
        // Money added to or taken from money stays money (two decimal places), as a report formula does.
        const money = formulaKeepsMoney(tree, (name) => MONEY_TYPE.test(columns.get(name) ?? ""));
        const type = money ? "DECIMAL(38,2)" : DECIMAL_RESULT;
        columns.set(step.name, type);
        sql = `select *, cast(${compile(tree)} as ${type}) as ${quote(step.name)} from ${source}`;
        break;
      }
    }
    if (step.type === "group" || step.type === "pivot" || step.type === "merge" || step.type === "append") unorderedBy = `step ${index + 1} (${STEP_LABELS[step.type]})`;
    if (step.type === "sort") unorderedBy = null;
    ctes.push(`${next} as (${sql})`);
    source = next;
  });

  const outputColumns = [...columns].map(([name, type]) => ({ name, type }));
  return { sql: `with ${ctes.join(", ")} select * from ${source}`, params, columns: outputColumns, merges, ctes: ctes.join(", "), steps: steps.length };
}

/**
 * One query answering a Merge step's checks (decision 693): how many match
 * values the other table repeats and the most rows one has, whether this
 * table repeats any, and how many of this table's rows have no match. Rows
 * with a blank match column never match, so they aren't counted as repeats.
 * Every CTE is kept so the query uses every parameter.
 */
export function mergeCheckSql(ctes: string, check: MergeCheck): string {
  const right = quote(check.table);
  const rightKeys = check.withColumns.map(quote).join(", ");
  const leftKeys = check.columns.map(quote).join(", ");
  const notBlank = (keys: string[]) => keys.map((key) => `${quote(key)} is not null`).join(" and ");
  const matched = check.columns.map((column, index) => `l.${quote(column)} = r.${quote(check.withColumns[index])}`).join(" and ");
  return `with ${ctes}
    select
      (select count(*) from (select ${rightKeys} from ${right} where ${notBlank(check.withColumns)} group by ${rightKeys} having count(*) > 1)) as right_repeats,
      (select max(n) from (select count(*) as n from ${right} where ${notBlank(check.withColumns)} group by ${rightKeys})) as right_most,
      (select cast(${check.withColumns.length === 1 ? rightKeys : `row(${rightKeys})`} as VARCHAR) from ${right} where ${notBlank(check.withColumns)} group by ${rightKeys} having count(*) > 1 order by count(*) desc, 1 limit 1) as right_example,
      (select count(*) from (select ${leftKeys} from ${check.source} where ${notBlank(check.columns)} group by ${leftKeys} having count(*) > 1)) as left_repeats,
      (select count(*) from ${check.source} l where not exists (select 1 from ${right} r where ${matched})) as unmatched,
      (select count(*) from ${check.source}) as rows`;
}

/** The check's answer, as a refusal (thrown) or notes on what the merge does. */
export function mergeCheckOutcome(
  check: MergeCheck,
  baseName: string,
  answer: { right_repeats: string | null; right_most: string | null; right_example: string | null; left_repeats: string | null; unmatched: string | null; rows: string | null },
): string[] {
  const on = check.withColumns.join(" and ");
  if (Number(answer.right_repeats ?? 0) > 0) {
    throw new ValidationError(
      `Step ${check.step}: ${check.table} has more than one row for the same ${on} (${answer.right_example ?? "one value"} has ${answer.right_most} rows), so each matching row here would be repeated and its amounts counted more than once (one invoice of 100.00 merged with its three lines would become 300.00). Merge on columns that are different on every row of ${check.table}, or group ${check.table} by ${on} first.`,
    );
  }
  if (Number(answer.left_repeats ?? 0) > 0 && check.numbers.length > 0) {
    throw new ValidationError(
      `Step ${check.step}: several rows here have the same ${check.columns.join(" and ")}, so ${check.numbers.join(", ")} from ${check.table} would repeat on each of them and add up more than once. Bring in text, dates or Yes/No only, or start from ${check.table} and merge these rows into it after grouping them.`,
    );
  }
  const notes: string[] = [];
  const unmatched = Number(answer.unmatched ?? 0);
  if (unmatched > 0) {
    const rows = `${unmatched.toLocaleString("en-NZ")} of ${Number(answer.rows ?? 0).toLocaleString("en-NZ")} rows`;
    notes.push(
      check.join === "inner"
        ? `Step ${check.step}: ${rows} of ${baseName} have no match in ${check.table} and are left out.`
        : `Step ${check.step}: ${rows} of ${baseName} have no match in ${check.table}; what they'd bring in is blank.`,
    );
  }
  return notes;
}
