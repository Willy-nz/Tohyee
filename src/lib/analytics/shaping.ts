import { ValidationError } from "@/lib/errors";
import { COLUMN_TYPES, type ColumnKind } from "@/lib/analytics/engine";

export type ShapeColumn = { name: string; type: string };

type Operand = { type: "column"; name: string } | { type: "number"; value: string };
export type ShapeStep =
  | { type: "filter"; column: string; test: "is" | "is not" | "contains" | "more than" | "at least" | "less than" | "at most" | "is empty" | "is not empty"; value?: string }
  | { type: "columns"; action: "keep" | "remove"; columns: string[] }
  | { type: "rename"; column: string; name: string }
  | { type: "type"; column: string; kind: ColumnKind }
  | { type: "split"; column: string; separator: string; names: string[] }
  | { type: "unpivot"; columns: string[]; attributeName: string; valueName: string }
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
  | { type: "append"; table: string };

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
const NUMBER_TYPE = /^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|DOUBLE|FLOAT)/;
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

export function parseShapeSteps(value: unknown): ShapeStep[] {
  if (!Array.isArray(value) || value.length > 100) throw new ValidationError("Steps must be a list of up to 100 steps.");
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
        if (typeof raw.kind !== "string" || !(raw.kind in COLUMN_TYPES)) return fail("choose a column type.");
        return { type: "type", column: named(raw.column, "Choose a column."), kind: raw.kind as ColumnKind };
      case "split":
        return {
          type: "split",
          column: named(raw.column, "Choose a column."),
          separator: text(raw.separator, "Enter a separator.", 100),
          names: names(raw.names, "Enter at least two new column names.", 2),
        };
      case "unpivot":
        return {
          type: "unpivot",
          columns: names(raw.columns, "Choose at least two columns to unpivot.", 2),
          attributeName: named(raw.attributeName, "Enter a valid attribute column name."),
          valueName: named(raw.valueName, "Enter a valid value column name."),
        };
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

export function buildShapeQuery(input: {
  baseTable: string;
  tables: Map<string, ShapeColumn[]>;
  steps: unknown;
  throughStep?: number;
}): { sql: string; params: unknown[]; columns: ShapeColumn[] } {
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

  const selected = (current: Map<string, string>) => [...current.keys()].map((name) => quote(name)).join(", ");
  const checkedNames = (current: Map<string, string>, value: string[]) => value.map((name) => requireColumn(current, name));

  steps.forEach((step, index) => {
    const next = `shape${index + 1}`;
    let sql: string;
    switch (step.type) {
      case "filter": {
        const column = requireColumn(columns, step.column);
        const field = quote(column);
        if (step.test === "is empty") sql = `select * from ${source} where ${field} is null or cast(${field} as varchar) = ''`;
        else if (step.test === "is not empty") sql = `select * from ${source} where ${field} is not null and cast(${field} as varchar) <> ''`;
        else {
          const value = param(step.value ?? "");
          const condition = {
            is: `${field} = ${value}`,
            "is not": `${field} <> ${value}`,
            contains: `contains(lower(cast(${field} as varchar)), lower(${value}))`,
            "more than": `${field} > ${value}`,
            "at least": `${field} >= ${value}`,
            "less than": `${field} < ${value}`,
            "at most": `${field} <= ${value}`,
          }[step.test];
          sql = `select * from ${source} where ${condition}`;
        }
        break;
      }
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
        const chosen = checkedNames(columns, step.columns);
        const remaining = [...columns].filter(([name]) => !chosen.includes(name));
        ensureUnused(new Map(remaining), [step.attributeName, step.valueName]);
        if (step.attributeName === step.valueName) throw new ValidationError("The unpivot output columns must have different names.");
        const types = chosen.map((name) => columns.get(name)!);
        const valueType = types.every((type) => type === types[0]) ? types[0] : "VARCHAR";
        columns = new Map([...remaining, [step.attributeName, "VARCHAR"], [step.valueName, valueType]]);
        sql = `select * from ${source} unpivot (${quote(step.valueName)} for ${quote(step.attributeName)} in (${chosen.map(quote).join(", ")}))`;
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
          const result = aggregate.operation === "average" ? `cast(avg(${expression}) as DECIMAL(38,6))` : `${fn}(${expression})`;
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
          expression = `(${left} ${step.expression.operator} ${step.expression.operator === "/" ? `nullif(${right}, 0)` : right})`;
          resultType = step.expression.operator === "/" ? "DECIMAL(38,6)" : "DECIMAL(38,6)";
          if (step.expression.operator === "/") expression = `cast(${expression} as DECIMAL(38,6))`;
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
        columns = new Map([...columns, ...additions.map(({ column, name }) => [name, right.get(column)!] as const)]);
        sql = `select ${[...[...columns.keys()].filter((name) => !additions.some((entry) => entry.name === name)).map((name) => `${quote("left_source")}.${quote(name)} as ${quote(name)}`), ...additions.map(({ column, name }) => `${quote("right_source")}.${quote(column)} as ${quote(name)}`)].join(", ")} from ${source} as ${quote("left_source")} ${step.join === "left" ? "left" : "inner"} join ${quote(step.table)} as ${quote("right_source")} on ${matches.join(" and ")}`;
        break;
      }
      case "append": {
        const right = tableColumns(input.tables, step.table);
        const merged = new Map(columns);
        for (const [name, type] of right) if (!merged.has(name)) merged.set(name, type);
        columns = merged;
        sql = `select * from ${source} union all by name select * from ${quote(step.table)}`;
        break;
      }
    }
    ctes.push(`${next} as (${sql})`);
    source = next;
  });

  const outputColumns = [...columns].map(([name, type]) => ({ name, type }));
  return { sql: `with ${ctes.join(", ")} select * from ${source}`, params, columns: outputColumns };
}
