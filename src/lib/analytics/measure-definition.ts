import { formulaKeepsMoney, parseFormula } from "@/lib/analytics/formula";
import { currencyFieldOf, formatOfType, type BaseMeasure, type ColumnInfo, type Measure } from "@/lib/analytics/query";

/**
 * What a value means, in words (#387, decision 696): what one row of its
 * table is, how the rows are added up, its unit, whether it's a movement in
 * the dates or a balance, the date it goes by, and what happens with no
 * rows, blanks, dividing by zero and totals. Worked out from the value's
 * definition and its table, so it can't drift from what the query does
 * (nothing here is typed in).
 */
export type MeasureMeaning = {
  row: string;
  aggregation: string;
  unit: string;
  kind: string;
  date: string;
  blanks: string;
  totals: string;
};

/** What one row is in the books copy's tables (examples AB1-AB11); other tables are one row of what was loaded. */
const ROWS: Record<string, string> = {
  tohyee_ledger_lines: "one posted journal line (one side of a journal)",
  tohyee_invoices: "one approved or voided sales invoice (never a draft)",
  tohyee_invoice_lines: "one line of an approved or voided sales invoice",
  tohyee_bills: "one approved or voided bill",
  tohyee_bill_lines: "one line of an approved or voided bill",
  tohyee_contacts: "one contact",
  tohyee_items: "one item",
  tohyee_crm_opportunities: "one CRM opportunity",
  tohyee_crm_activities: "one CRM activity",
  tohyee_crm_companies: "one CRM company",
};

export function rowMeaning(table: string): string {
  return ROWS[table] ?? `one row of ${table}, as it was loaded`;
}

const AGGREGATES: Record<string, string> = {
  sum: "the total of",
  avg: "the average (each row counts once) of",
  min: "the smallest",
  max: "the largest",
  count: "the number of rows",
  count_distinct: "the number of different values of",
};

function words(name: string): string {
  return name.replaceAll("_", " ");
}

function baseAggregation(measure: BaseMeasure): string {
  if (measure.aggregate === "count") return measure.field ? `the number of rows with a ${words(measure.field)}` : "the number of rows";
  const of = measure.times ? `${words(measure.field!)} × ${words(measure.times)}` : words(measure.field ?? "");
  const negated = measure.negate ? ", the other way round (each amount negated)" : "";
  return `${AGGREGATES[measure.aggregate]} ${of}${negated}`;
}

function unitOf(measure: BaseMeasure, types: Map<string, string>, baseCurrency: string): string {
  if (measure.aggregate === "count" || measure.aggregate === "count_distinct") return "a count";
  const formats = [measure.field, measure.times].filter(Boolean).map((field) => formatOfType(types.get(field!) ?? ""));
  const currency = currencyFieldOf(measure, types);
  if (formats.includes("money")) {
    return currency ? `money, in each row's ${words(currency)} (amounts in different currencies aren't added together)` : `money, in ${baseCurrency}`;
  }
  if (formats.includes("date")) return "a date";
  return "a number";
}

/**
 * A value's meaning on a table. `dateField` is the date the dashboard's
 * dates apply to on the tile (or the table's first date for a saved value).
 */
export function describeMeasure(measure: Measure, table: string, columns: ColumnInfo[], dateField: string | null, baseCurrency = "NZD"): MeasureMeaning {
  const types = new Map(columns.map((column) => [column.name, column.type]));
  const row = rowMeaning(table);
  const date = dateField ? words(dateField) : null;
  if (measure.aggregate === "formula") {
    const formula = measure.formula ?? "";
    let money = false;
    try {
      const inputs = new Map((measure.inputs ?? []).map((input) => [input.name, input]));
      money = formulaKeepsMoney(parseFormula(formula), (name) => {
        const input = inputs.get(name);
        return input ? unitOf(input, types, baseCurrency).startsWith("money") : false;
      });
    } catch {
      money = false;
    }
    const balances = (measure.inputs ?? []).some((input) => input.asAt);
    return {
      row,
      aggregation: `worked out with ${formula} from the values it names, each added up over the same rows first`,
      unit: money ? `money, in ${baseCurrency}` : "a number (choose percentage in Format for a ratio)",
      kind: balances ? "uses a balance as at the To date with movements in the dates" : "worked out from movements in the dates",
      date: date ? `goes by ${date}` : "no date: every row counts",
      blanks: "a value it names with no rows counts as 0; dividing by zero gives no value (blank), never 0 or an error",
      totals: "totals and subtotals work the formula out again from their own totals (10/100 and 90/300 total 25%, not the average 20%)",
    };
  }
  const base = measure as BaseMeasure;
  const kind = base.snapshot
    ? `a balance recorded on each date: the latest row in each period${base.snapshot.per ? ` for each ${words(base.snapshot.per)}` : ""}, added up; never added across dates`
    : base.asAt
      ? "a balance: every row up to the To date, whatever the From date"
      : base.aggregate === "count" || base.aggregate === "count_distinct"
        ? "a count of the rows in the dates"
        : "a movement: the rows in the dates";
  const blanks =
    base.aggregate === "count" || base.aggregate === "count_distinct"
      ? "no rows count as 0"
      : "rows with no value are left out; with no rows at all it's blank, not 0";
  const totals = (
    {
      sum: "totals add the rows up exactly",
      count: "totals add the counts up",
      avg: "a total is the average of all the rows, not the average of the averages",
      min: "a total is the smallest of all the rows",
      max: "a total is the largest of all the rows",
      count_distinct: "a total counts the different values over all the rows (not the counts added up)",
    } as Record<string, string>
  )[base.aggregate];
  return {
    row,
    aggregation: baseAggregation(base),
    unit: unitOf(base, types, baseCurrency),
    kind,
    date: base.asAt && date ? `up to the To date, by ${date}` : base.snapshot && date ? `the date each balance was recorded (${date})` : date ? `goes by ${date}` : "no date: every row counts",
    blanks,
    totals,
  };
}
