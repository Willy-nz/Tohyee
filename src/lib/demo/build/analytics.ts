import { refreshBooks } from "@/lib/analytics/books";
import { createDashboard, describeTables, type Tile } from "@/lib/analytics/dashboards";
import { builtInMeasures, measureFromSaved } from "@/lib/analytics/measure-library";
import type { Filter, Measure, TileQuery } from "@/lib/analytics/query";
import { createShapedTable, runShapedTable } from "@/lib/analytics/shaped-tables";
import { buildTemplate, lastTwelveMonths } from "@/lib/analytics/templates";
import type { DemoContext } from "@/lib/demo/build/context";

/*
 * Analytics for the demo farm (#437): the books copied in, a shaped table
 * that puts milk solids beside the ledger (so working expenses per kg MS is
 * one tile), and four ready reports: Farm performance and Accounts (made
 * here) and the Farm and Business overview templates. Ordinary reports, so
 * anything can be changed after.
 */

/** The shaped table: the co-op invoice lines' kg MS appended to the ledger lines, on one date column. */
export const FARM_MONTH_TABLE = "demo_milk_and_ledger";

const question = (table: string, measures: Measure[], extra: Partial<TileQuery> = {}): TileQuery => ({
  table,
  groupBy: null,
  pivot: null,
  measures,
  filters: [],
  dateField: null,
  sort: { by: "category", direction: "asc" },
  limit: null,
  ...extra,
});

/** Working expenses: expense accounts, less interest (not a working expense). Depreciation is its own type, so it's out already. */
const WORKING: Filter[] = [
  { field: "account_type", op: "eq", value: "expense" },
  { field: "account_code", op: "neq", value: "6090" },
];
const MILK: Filter = { field: "item_code", op: "eq", value: "MS" };

export async function setUpAnalytics(ctx: DemoContext): Promise<string[]> {
  const run = await refreshBooks(ctx.organisation, ctx.actor, "manual");
  if (run.status !== "ok") throw new Error(`Copying the demo farm's books into Analytics failed: ${run.error ?? run.status}`);
  const shape = await ctx.as((tx) =>
    createShapedTable(tx, {
      name: "Milk solids and the ledger",
      tableName: FARM_MONTH_TABLE,
      baseTable: "tohyee_invoice_lines",
      steps: [
        { type: "filter", column: "item_code", test: "is", value: "MS" },
        { type: "columns", action: "keep", columns: ["invoice_date", "quantity"] },
        { type: "rename", column: "invoice_date", name: "posting_date" },
        { type: "rename", column: "quantity", name: "kg_ms" },
        { type: "append", table: "tohyee_ledger_lines" },
      ],
    }),
  );
  const shaped = await runShapedTable(ctx.organisation, ctx.actor, shape.id, "manual");
  if (shaped.status !== "ok") throw new Error(`Shaping the demo farm's milk and ledger table failed: ${shaped.error ?? shaped.status}`);

  const tables = await describeTables(ctx.organisation.id);
  const ledger = "tohyee_ledger_lines";
  const builtIns = builtInMeasures(ledger, tables.find((table) => table.name === ledger)?.columns ?? []);
  const value = (name: string, extra: Partial<Measure> = {}): Measure => ({ ...measureFromSaved(builtIns.find((measure) => measure.name === name)!), ...extra });
  const settings = { ...lastTwelveMonths(ctx.today), preset: "last_12_months", slicers: [] };
  let count = 0;
  const tile = (title: string, visual: Tile["visual"], width: Tile["width"], query: TileQuery | null, extra: Partial<Tile> = {}): Tile => ({ id: `demo-${++count}`, title, visual, width, query, ...extra });
  const plainNumber = (suffix: string, decimals = 0) => ({ series: [{ number: { style: "plain" as const, decimals, suffix } }] });

  const lines = "tohyee_invoice_lines";
  const kgMs: Measure = { label: "kg MS", aggregate: "sum", field: "quantity", where: [MILK] };
  const milkIncome: Measure = { label: "Milk income", aggregate: "sum", field: "net", where: [MILK] };
  const performance: Tile[] = [
    tile("Farm performance", "text", "full", null, { text: "Made-up figures for the demo farm. Milk solids come from the co-op's monthly invoices; working expenses from the ledger (expense accounts, less interest); pasture cover from the farm walks." }),
    tile("Milk solids", "kpi", "third", question(lines, [kgMs], { dateField: "invoice_date", sparkline: true }), { format: plainNumber("kg MS") }),
    tile("Milk price", "kpi", "third", question(lines, [{ label: "$/kg MS", aggregate: "formula", formula: "[Milk income] / [kg MS]" }, milkIncome, kgMs], { dateField: "invoice_date" }), {
      format: { series: [{ number: { style: "currency", decimals: 2 } }, {}, {}] },
    }),
    tile(
      "Working expenses per kg MS",
      "kpi",
      "third",
      question(FARM_MONTH_TABLE, [
        { label: "$/kg MS", aggregate: "formula", formula: "[Working expenses] / [kg MS]" },
        { label: "Working expenses", aggregate: "sum", field: "amount", where: WORKING },
        { label: "kg MS", aggregate: "sum", field: "kg_ms" },
      ], { dateField: "posting_date" }),
      { format: { series: [{ number: { style: "currency", decimals: 2 } }, {}, {}], kpi: { downIsGood: true } } },
    ),
    tile("Milk solids by month", "column", "two-thirds", question(lines, [kgMs], { groupBy: { field: "invoice_date", grain: "month" }, dateField: "invoice_date" }), { format: plainNumber("kg MS") }),
    tile("Average pasture cover", "kpi", "third", question("tohyee_farm_pasture_readings", [{ label: "kg DM/ha", aggregate: "avg", field: "cover_kg_dm_ha" }], { dateField: "measured_on", sparkline: true }), {
      format: plainNumber("kg DM/ha"),
    }),
    tile(
      "Working expenses and milk solids by month",
      "combo",
      "two-thirds",
      question(FARM_MONTH_TABLE, [{ label: "Working expenses", aggregate: "sum", field: "amount", where: WORKING }, { label: "kg MS", aggregate: "sum", field: "kg_ms" }], {
        groupBy: { field: "posting_date", grain: "month" },
        dateField: "posting_date",
      }),
      { format: { series: [{ as: "bar" }, { as: "line", axis: "right", number: { style: "plain", decimals: 0 } }], rightAxis: { title: "kg MS" } } },
    ),
    tile("Pasture cover by month", "line", "third", question("tohyee_farm_pasture_readings", [{ label: "Average cover (kg DM/ha)", aggregate: "avg", field: "cover_kg_dm_ha" }], { groupBy: { field: "measured_on", grain: "month" }, dateField: "measured_on" }), {
      format: { series: [{ number: { style: "plain", decimals: 0 } }], valueAxis: { zero: false } },
    }),
  ];

  const gst: Filter = { field: "system_account", op: "eq", value: "gst" };
  const accounts: Tile[] = [
    tile("Profit", "kpi", "quarter", question(ledger, [value("Net profit")], { dateField: "posting_date", sparkline: true })),
    tile("Income", "kpi", "quarter", question(ledger, [value("Sales")], { dateField: "posting_date", sparkline: true })),
    tile("Cash in bank", "kpi", "quarter", question(ledger, [value("Cash in bank")], { dateField: "posting_date" })),
    tile("GST owed to Inland Revenue", "kpi", "quarter", question(ledger, [{ label: "GST", aggregate: "sum", field: "amount", negate: true, asAt: true, where: [gst] }], { dateField: "posting_date" })),
    tile("Profit by month", "column", "two-thirds", question(ledger, [value("Net profit")], { groupBy: { field: "posting_date", grain: "month" }, dateField: "posting_date" }), { format: { negativeRed: true } }),
    tile("GST by month (charged less claimed)", "column", "third", question(ledger, [{ label: "GST", aggregate: "sum", field: "amount", negate: true, where: [gst, { field: "source", op: "neq", value: "bank_transaction" }] }], {
      groupBy: { field: "posting_date", grain: "month" },
      dateField: "posting_date",
    }), { format: { negativeRed: true } }),
    tile("Expenses by account", "bar", "full", question(ledger, [{ label: "Expenses", aggregate: "sum", field: "amount", where: [{ field: "account_type", op: "in", value: ["expense", "depreciation", "direct_costs"] }] }], {
      groupBy: { field: "account_name" },
      dateField: "posting_date",
      sort: { by: "value", direction: "desc" },
      limit: 12,
    })),
  ];

  const ids: string[] = [];
  await ctx.as(async (tx) => {
    ids.push((await createDashboard(tx, { name: "Farm performance", description: "Milk solids, milk price, pasture cover and working expenses per kg MS.", settings, tiles: performance })).id);
    ids.push((await createDashboard(tx, { name: "Accounts: profit, cash and GST", description: "Profit, income, cash in the bank and GST.", settings, tiles: accounts })).id);
    for (const id of ["farm", "overview"] as const) {
      const built = buildTemplate(id, tables, ctx.today);
      if (built) ids.push((await createDashboard(tx, { name: built.name, description: built.description, settings: built.settings, tiles: built.tiles })).id);
    }
  });
  return ids;
}
