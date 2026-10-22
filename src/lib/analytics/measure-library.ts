import type { NumberFormat } from "@/lib/analytics/chart-format";
import { formulaRefs, parseFormula } from "@/lib/analytics/formula";
import type { BaseMeasure, ColumnInfo, FormulaInput, Measure } from "@/lib/analytics/query";

/**
 * Saved values (#337, decision 597): a value kept on a data source (a loaded
 * table) under a name, so any chart can use it. Built-in ones come with the
 * books copy (examples BM1-BM4); people save their own.
 */
export type MeasureDefinition =
  | (BaseMeasure & { kind: "base" })
  | { kind: "formula"; formula: string; inputs: FormulaInput[] };

export type SavedMeasure = {
  /** null for a built-in value. */
  id: string | null;
  table: string;
  name: string;
  description: string | null;
  definition: MeasureDefinition;
  /** How it's best shown, e.g. Gross margin % as a percentage. */
  number?: NumberFormat;
};

const LEDGER = "tohyee_ledger_lines";

const base = (measure: BaseMeasure): MeasureDefinition => ({ kind: "base", ...measure });
const of = (field: string, value: string | string[]) =>
  Array.isArray(value) ? { field, op: "in" as const, value } : { field, op: "eq" as const, value };

const SALES: FormulaInput = { name: "Sales", aggregate: "sum", field: "amount", negate: true, where: [of("account_type", "revenue")] };
const COST_OF_SALES: FormulaInput = { name: "Cost of sales", aggregate: "sum", field: "amount", where: [of("account_type", "direct_costs")] };
const OTHER_INCOME: FormulaInput = { name: "Other income", aggregate: "sum", field: "amount", negate: true, where: [of("account_type", "other_income")] };
const OPERATING_EXPENSES: FormulaInput = { name: "Operating expenses", aggregate: "sum", field: "amount", where: [of("account_type", ["expense", "depreciation"])] };
const RECEIVABLE: FormulaInput = { name: "Accounts receivable", aggregate: "sum", field: "amount", asAt: true, where: [of("system_account", "accounts_receivable")] };
const PAYABLE: FormulaInput = { name: "Accounts payable", aggregate: "sum", field: "amount", negate: true, asAt: true, where: [of("system_account", "accounts_payable")] };
const BANK: FormulaInput = { name: "Cash in bank", aggregate: "sum", field: "amount", asAt: true, where: [of("account_type", "bank")] };

function baseOf(input: FormulaInput): MeasureDefinition {
  const { name: _name, ...rest } = input;
  void _name;
  return base(rest);
}

/**
 * The books copy's built-in values, defined as Tohyee's (and Xero's) profit
 * and loss and balance sheet define them (examples BM1-BM4, as Xero does,
 * not yet reviewed). Balances are as at the dashboard's To date.
 */
const BOOKS_MEASURES: Array<Omit<SavedMeasure, "id" | "table"> & { needs: string[] }> = [
  { name: "Sales", description: "Income from revenue accounts (trading income), the other way round so it shows positive.", definition: baseOf(SALES), needs: ["account_type"] },
  { name: "Cost of sales", description: "Direct costs accounts.", definition: baseOf(COST_OF_SALES), needs: ["account_type"] },
  { name: "Gross profit", description: "Sales less cost of sales.", definition: { kind: "formula", formula: "[Sales] - [Cost of sales]", inputs: [SALES, COST_OF_SALES] }, needs: ["account_type"] },
  {
    name: "Gross margin %",
    description: "Gross profit as a share of sales.",
    definition: { kind: "formula", formula: "([Sales] - [Cost of sales]) / [Sales]", inputs: [SALES, COST_OF_SALES] },
    number: { style: "percent", decimals: 1 },
    needs: ["account_type"],
  },
  { name: "Other income", description: "Other income accounts, e.g. interest received.", definition: baseOf(OTHER_INCOME), needs: ["account_type"] },
  { name: "Operating expenses", description: "Expense and depreciation accounts.", definition: baseOf(OPERATING_EXPENSES), needs: ["account_type"] },
  {
    name: "Net profit",
    description: "Gross profit plus other income less operating expenses.",
    definition: { kind: "formula", formula: "[Sales] - [Cost of sales] + [Other income] - [Operating expenses]", inputs: [SALES, COST_OF_SALES, OTHER_INCOME, OPERATING_EXPENSES] },
    needs: ["account_type"],
  },
  { name: "Accounts receivable", description: "What customers owe, as at the To date.", definition: baseOf(RECEIVABLE), needs: ["system_account"] },
  { name: "Accounts payable", description: "What's owed to suppliers, as at the To date.", definition: baseOf(PAYABLE), needs: ["system_account"] },
  { name: "Cash in bank", description: "Bank account balances as at the To date.", definition: baseOf(BANK), needs: ["account_type"] },
  {
    name: "Days to get paid",
    description: "Accounts receivable at the To date divided by the period's average sales a day (needs both dashboard dates).",
    definition: { kind: "formula", formula: "[Accounts receivable] * days / [Sales]", inputs: [RECEIVABLE, SALES] },
    number: { style: "plain", decimals: 1, suffix: "days" },
    needs: ["system_account", "account_type"],
  },
];

/** The built-in values a table has (the books copy's ledger lines, once copied with the columns they need). */
export function builtInMeasures(table: string, columns: ColumnInfo[]): SavedMeasure[] {
  if (table !== LEDGER) return [];
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("amount")) return [];
  return BOOKS_MEASURES.filter((entry) => entry.needs.every((name) => names.has(name))).map((entry) => {
    const { needs, ...rest } = entry;
    void needs;
    return { ...rest, id: null, table };
  });
}

/** A saved value as one of a chart's values, named `label`. */
export function measureFromSaved(saved: SavedMeasure, label = saved.name): Measure {
  if (saved.definition.kind === "formula") {
    return { label, aggregate: "formula", formula: saved.definition.formula, inputs: saved.definition.inputs.map((input) => ({ ...input })) };
  }
  const { kind: _kind, ...rest } = saved.definition;
  void _kind;
  return { label, ...rest };
}

/**
 * A chart's value as a definition to save on its data source. A formula's
 * [names] that are the chart's other values are copied in as its inputs,
 * so the saved value stands on its own.
 */
export function definitionToSave(measure: Measure, siblings: Measure[]): MeasureDefinition {
  if (measure.aggregate !== "formula") {
    const { label: _label, compare: _compare, formula: _formula, inputs: _inputs, quick: _quick, period: _period, ...rest } = measure;
    void _label;
    void _compare;
    void _formula;
    void _inputs;
    void _quick;
    void _period;
    return { kind: "base", ...(rest as BaseMeasure) };
  }
  const inputs = [...(measure.inputs ?? [])];
  for (const name of formulaRefs(parseFormula(measure.formula ?? ""))) {
    if (inputs.some((input) => input.name === name)) continue;
    const sibling = siblings.find((other) => other !== measure && other.aggregate !== "formula" && other.label === name);
    if (!sibling) throw new Error(`[${name}] isn't one of this chart's values.`);
    const { label: _label, compare: _compare, formula: _formula, inputs: _inputs, quick: _quick, period: _period, ...rest } = sibling;
    void _label;
    void _compare;
    void _formula;
    void _inputs;
    void _quick;
    void _period;
    inputs.push({ name, ...(rest as BaseMeasure) });
  }
  return { kind: "formula", formula: measure.formula ?? "", inputs };
}
