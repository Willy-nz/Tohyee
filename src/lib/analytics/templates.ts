import type { ChartFormat } from "@/lib/analytics/chart-format";
import type { Tile, DashboardSettings } from "@/lib/analytics/dashboards";
import { builtInMeasures, measureFromSaved } from "@/lib/analytics/measure-library";
import type { ColumnInfo, Filter, Measure, TileQuery } from "@/lib/analytics/query";

/**
 * Ready-made reports (#337, decision 597): Business overview, Sales and
 * customers, Profit and loss, CRM pipeline and Farm; and Website, over the
 * Google Analytics tables (decision 609); and Website search, over the
 * Google Search Console tables (decision 1186). Each is a dashboard of
 * ordinary tiles over the books copy, so everything can be changed after.
 * A template is offered only when the tables it needs are loaded.
 */

export type TemplateId = "overview" | "sales" | "profit" | "crm" | "farm" | "website" | "search";
export type TableInfo = { name: string; columns: ColumnInfo[] };

export const TEMPLATES: Array<{ id: TemplateId; name: string; description: string; needs: string[] }> = [
  { id: "overview", name: "Business overview", description: "Sales, profit, cash and what's owed, with the month by month trend.", needs: ["tohyee_ledger_lines"] },
  { id: "sales", name: "Sales & customers", description: "Invoiced sales by month, top customers, and how many invoices and customers.", needs: ["tohyee_invoices"] },
  { id: "profit", name: "Profit & loss", description: "Sales, cost of sales, gross and net profit against last year, and the accounts behind them.", needs: ["tohyee_ledger_lines"] },
  { id: "crm", name: "CRM pipeline", description: "Open opportunities by stage and owner, what's expected to close, and won against lost.", needs: ["tohyee_crm_opportunities"] },
  { id: "farm", name: "Farm", description: "Pasture cover, supplements fed and fertiliser applied, by month and paddock.", needs: ["tohyee_farm_pasture_readings", "tohyee_farm_supplements", "tohyee_farm_fertiliser_applications"] },
  {
    id: "website",
    name: "Website",
    description: "Visitors, sessions and page views from Google Analytics by month, where they came from, top pages and devices, beside invoiced sales.",
    needs: ["google_analytics_daily", "google_analytics_traffic", "google_analytics_pages", "google_analytics_devices"],
  },
  {
    id: "search",
    name: "Website search",
    description: "How the website does in Google search, from Search Console: clicks and impressions over time, top searches and pages, searches shown a lot but rarely clicked, countries and devices.",
    needs: ["google_search_console_daily", "google_search_console_queries", "google_search_console_pages", "google_search_console_countries", "google_search_console_devices"],
  },
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The last twelve whole months, this one included: e.g. 1 Nov 2025 to 31 Oct 2026. */
export function lastTwelveMonths(today: string): { from: string; to: string } {
  const [year, month] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 12, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01`, to: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}` };
}

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

type Build = {
  tile: (title: string, visual: Tile["visual"], width: Tile["width"], query: TileQuery | null, extra?: Partial<Tile>) => Tile;
};

function builder(prefix: string): Build {
  let count = 0;
  return {
    tile: (title, visual, width, query, extra = {}) => ({ id: `${prefix}-${++count}`, title, visual, width, query, ...extra }),
  };
}

const percent: ChartFormat["series"] = [{ number: { style: "percent", decimals: 1 } }];

/** The tiles and dates of a template, or null when a table it needs isn't loaded. */
export function buildTemplate(id: TemplateId, tables: TableInfo[], today: string): { name: string; description: string; settings: DashboardSettings; tiles: Tile[] } | null {
  const template = TEMPLATES.find((entry) => entry.id === id)!;
  const byName = new Map(tables.map((table) => [table.name, table]));
  if (!template.needs.every((name) => byName.has(name))) return null;
  const { tile } = builder(id);
  // Dated "Last 12 months", so the report moves on with time (the dates are worked out again when it's opened).
  const settings: DashboardSettings = { ...lastTwelveMonths(today), preset: "last_12_months", slicers: [] };
  const tiles: Tile[] = [];
  const ledger = "tohyee_ledger_lines";
  const builtIns = builtInMeasures(ledger, byName.get(ledger)?.columns ?? []);
  const has = (name: string) => builtIns.some((measure) => measure.name === name);
  const value = (name: string, extra: Partial<Measure> = {}): Measure => ({ ...measureFromSaved(builtIns.find((measure) => measure.name === name)!), ...extra });
  // A trend by month only for figures over a period (a balance can't be grouped by month).
  const keyFigure = (name: string, compare: Measure["compare"], extra: Partial<Tile> = {}) =>
    tile(name, "kpi", "quarter", question(ledger, [value(name, compare ? { compare } : {})], { dateField: "posting_date", sparkline: true }), extra);
  const numberFor = (name: string) => builtIns.find((measure) => measure.name === name)?.number;

  if (id === "overview") {
    tiles.push(tile("This year at a glance", "text", "full", null, { text: "The last twelve months against the twelve before. Change the dates above to look at another period." }));
    for (const name of ["Sales", "Gross profit", "Net profit"]) tiles.push(keyFigure(name, "previous_period"));
    tiles.push(tile("Cash in bank", "kpi", "quarter", question(ledger, [value("Cash in bank")], { dateField: "posting_date" })));
    tiles.push(
      tile("Sales and gross margin by month", "combo", "two-thirds", question(ledger, [value("Sales"), value("Gross margin %")], { groupBy: { field: "posting_date", grain: "month" }, dateField: "posting_date" }), {
        format: { series: [{ as: "bar" }, { as: "line", axis: "right", number: { style: "percent", decimals: 0 } }], rightAxis: { title: "Gross margin" } },
      }),
    );
    tiles.push(
      tile("Operating expenses by account", "bar", "third", question(ledger, [{ label: "Operating expenses", aggregate: "sum", field: "amount", where: [{ field: "account_type", op: "in", value: ["expense", "depreciation"] }] }], {
        groupBy: { field: "account_name" },
        dateField: "posting_date",
        sort: { by: "value", direction: "desc" },
        limit: 8,
      })),
    );
    if (has("Accounts receivable")) {
      for (const name of ["Accounts receivable", "Accounts payable", "Days to get paid"]) {
        const number = numberFor(name);
        tiles.push(tile(name, "kpi", "third", question(ledger, [value(name)], { dateField: "posting_date" }), number ? { format: { series: [{ number }] } } : {}));
      }
    }
  }

  if (id === "profit") {
    tiles.push(tile("Profit and loss", "text", "full", null, { text: "As the profit and loss report works it out: sales less cost of sales is gross profit; add other income and take off operating expenses for net profit. Each figure is against the same months last year." }));
    for (const name of ["Sales", "Cost of sales", "Gross profit", "Net profit"]) {
      tiles.push(keyFigure(name, "previous_year", name === "Cost of sales" ? { format: { kpi: { downIsGood: true } } } : {}));
    }
    tiles.push(tile("Net profit by month", "column", "two-thirds", question(ledger, [value("Net profit")], { groupBy: { field: "posting_date", grain: "month" }, dateField: "posting_date" }), { format: { negativeRed: true } }));
    tiles.push(tile("Gross margin", "kpi", "third", question(ledger, [value("Gross margin %", { compare: "previous_year" })], { dateField: "posting_date", sparkline: true }), { format: { series: percent } }));
    const profitAccounts: Filter = { field: "account_class", op: "in", value: ["revenue", "expense"] };
    tiles.push(
      tile("By account", "pivot", "full", question(ledger, [{ label: "Amount (income positive)", aggregate: "sum", field: "amount", negate: true }], {
        pivot: { rows: [{ field: "account_type" }, { field: "account_name" }], column: null },
        filters: [profitAccounts],
        dateField: "posting_date",
      })),
    );
  }

  if (id === "sales") {
    const invoices = "tohyee_invoices";
    const approved: Filter = { field: "status", op: "eq", value: "approved" };
    const sales: Measure = { label: "Sales (excl. GST)", aggregate: "sum", field: "net" };
    const count: Measure = { label: "Invoices", aggregate: "count" };
    const kpi = (title: string, measure: Measure, format?: ChartFormat) =>
      tile(title, "kpi", "quarter", question(invoices, [measure], { filters: [approved], dateField: "invoice_date", sparkline: true }), format ? { format } : {});
    tiles.push(kpi("Sales", { ...sales, compare: "previous_period" }));
    tiles.push(kpi("Invoices", { ...count, compare: "previous_period" }, { series: [{ number: { suffix: "invoices" } }] }));
    tiles.push(kpi("Customers invoiced", { label: "Customers", aggregate: "count_distinct", field: "contact" }, { series: [{ number: { suffix: "customers" } }] }));
    tiles.push(
      tile("Average invoice", "kpi", "quarter", question(invoices, [sales, count, { label: "Average invoice", aggregate: "formula", formula: "[Sales (excl. GST)] / [Invoices]" }], { filters: [approved], dateField: "invoice_date" }), {
        format: { series: [{}, {}, { number: { style: "currency" } }] },
      }),
    );
    tiles.push(
      tile("Sales and invoices by month", "combo", "two-thirds", question(invoices, [sales, count], { groupBy: { field: "invoice_date", grain: "month" }, filters: [approved], dateField: "invoice_date" }), {
        format: { series: [{ as: "bar" }, { as: "line", axis: "right" }], rightAxis: { title: "Invoices" } },
      }),
    );
    tiles.push(
      tile("Top customers", "bar", "third", question(invoices, [sales], { groupBy: { field: "contact" }, filters: [approved], dateField: "invoice_date", sort: { by: "value", direction: "desc" }, limit: 10 }), {
        format: { labels: { show: true }, series: [{ number: { compact: true } }] },
      }),
    );
  }

  if (id === "crm") {
    const opportunities = "tohyee_crm_opportunities";
    const open: Filter = { field: "outcome", op: "eq", value: "open" };
    const amount: Measure = { label: "Amount", aggregate: "sum", field: "amount" };
    tiles.push(tile("Open pipeline", "kpi", "quarter", question(opportunities, [amount], { filters: [open] })));
    tiles.push(tile("Open opportunities", "kpi", "quarter", question(opportunities, [{ label: "Opportunities", aggregate: "count" }], { filters: [open] }), { format: { series: [{ number: { suffix: "open" } }] } }));
    tiles.push(tile("Won", "kpi", "quarter", question(opportunities, [amount], { filters: [{ field: "outcome", op: "eq", value: "won" }], dateField: "expected_close" })));
    tiles.push(tile("Lost", "kpi", "quarter", question(opportunities, [amount], { filters: [{ field: "outcome", op: "eq", value: "lost" }], dateField: "expected_close" })));
    tiles.push(tile("Open pipeline by stage", "column", "half", question(opportunities, [amount, { label: "Opportunities", aggregate: "count" }], { groupBy: { field: "stage" }, filters: [open] }), {
      format: { series: [{}, { number: { style: "plain" } }] },
    }));
    tiles.push(tile("Open pipeline by owner", "bar", "half", question(opportunities, [amount], { groupBy: { field: "owner" }, filters: [open], sort: { by: "value", direction: "desc" } })));
    tiles.push(tile("Expected to close, by month", "column", "full", question(opportunities, [amount], { groupBy: { field: "expected_close", grain: "month" }, filters: [open], dateField: "expected_close" })));
  }

  if (id === "farm") {
    const pasture = "tohyee_farm_pasture_readings";
    const supplements = "tohyee_farm_supplements";
    const fertiliser = "tohyee_farm_fertiliser_applications";
    tiles.push(tile("Average pasture cover", "kpi", "third", question(pasture, [{ label: "kg DM/ha", aggregate: "avg", field: "cover_kg_dm_ha", compare: "previous_year" }], { dateField: "measured_on", sparkline: true }), {
      format: { series: [{ number: { style: "plain", decimals: 0, suffix: "kg DM/ha" } }] },
    }));
    tiles.push(tile("Supplements fed", "kpi", "third", question(supplements, [{ label: "kg DM", aggregate: "sum", field: "kg_dm", compare: "previous_year" }], { dateField: "fed_on", sparkline: true }), {
      format: { series: [{ number: { style: "plain", decimals: 0, suffix: "kg DM" } }] },
    }));
    tiles.push(tile("Fertiliser applied", "kpi", "third", question(fertiliser, [{ label: "Tonnes", aggregate: "sum", field: "tonnes", compare: "previous_year" }], { dateField: "applied_on", sparkline: true }), {
      format: { series: [{ number: { style: "plain", decimals: 1, suffix: "t" } }] },
    }));
    tiles.push(tile("Pasture cover by month", "line", "two-thirds", question(pasture, [{ label: "Average cover (kg DM/ha)", aggregate: "avg", field: "cover_kg_dm_ha" }], { groupBy: { field: "measured_on", grain: "month" }, dateField: "measured_on" }), {
      format: { series: [{ number: { style: "plain", decimals: 0 } }], valueAxis: { zero: false } },
    }));
    tiles.push(tile("Supplements by feed", "donut", "third", question(supplements, [{ label: "kg DM", aggregate: "sum", field: "kg_dm" }], { groupBy: { field: "feed" }, dateField: "fed_on", sort: { by: "value", direction: "desc" } }), {
      format: { donutTotal: true, series: [{ number: { style: "plain", decimals: 0 } }] },
    }));
    tiles.push(tile("Fertiliser by paddock", "bar", "full", question(fertiliser, [{ label: "Tonnes", aggregate: "sum", field: "tonnes" }], { groupBy: { field: "paddock" }, dateField: "applied_on", sort: { by: "value", direction: "desc" }, limit: 15 })));
  }

  if (id === "website") {
    // Google Analytics (decision 609): website visits by month, with sales from the books beside them when they're copied.
    const daily = "google_analytics_daily";
    const visitors: Measure = { label: "Visitors", aggregate: "sum", field: "active_users" };
    const sessions: Measure = { label: "Sessions", aggregate: "sum", field: "sessions" };
    const plain = (suffix: string): ChartFormat => ({ series: [{ number: { style: "plain", decimals: 0, suffix } }] });
    tiles.push(tile("Website", "text", "full", null, {
      text: "From Google Analytics, loaded nightly. Visitors are counted each day, so a month's visitors count someone who came on two days twice. Revenue and key events are only there if the website sends them to Google Analytics.",
    }));
    tiles.push(tile("Visitors", "kpi", "quarter", question(daily, [{ ...visitors, compare: "previous_period" }], { dateField: "date", sparkline: true }), { format: plain("visitors") }));
    tiles.push(tile("Sessions", "kpi", "quarter", question(daily, [{ ...sessions, compare: "previous_period" }], { dateField: "date", sparkline: true }), { format: plain("sessions") }));
    tiles.push(tile("Page views", "kpi", "quarter", question(daily, [{ label: "Page views", aggregate: "sum", field: "page_views", compare: "previous_period" }], { dateField: "date", sparkline: true }), { format: plain("views") }));
    tiles.push(
      tile("Engagement rate", "kpi", "quarter", question(daily, [{ label: "Engagement rate", aggregate: "formula", formula: "[Engaged sessions] / [Sessions]" }, { label: "Engaged sessions", aggregate: "sum", field: "engaged_sessions" }, sessions], { dateField: "date" }), {
        // The key figure shows the first value; the other two are what it's worked out from.
        format: { series: [{ number: { style: "percent", decimals: 1 } }, {}, {}] },
      }),
    );
    const salesBeside = byName.has("tohyee_invoices");
    tiles.push(
      tile("Visitors and sessions by month", "combo", salesBeside ? "half" : "two-thirds", question(daily, [visitors, sessions], { groupBy: { field: "date", grain: "month" }, dateField: "date" }), {
        format: { series: [{ as: "bar", number: { style: "plain", decimals: 0 } }, { as: "line", number: { style: "plain", decimals: 0 } }] },
      }),
    );
    if (salesBeside) {
      tiles.push(
        tile("Sales by month", "column", "half", question("tohyee_invoices", [{ label: "Sales (excl. GST)", aggregate: "sum", field: "net" }], {
          groupBy: { field: "invoice_date", grain: "month" },
          filters: [{ field: "status", op: "eq", value: "approved" }],
          dateField: "invoice_date",
        })),
      );
    }
    tiles.push(
      tile("Sessions by channel", "bar", "third", question("google_analytics_traffic", [sessions], { groupBy: { field: "channel" }, dateField: "date", sort: { by: "value", direction: "desc" }, limit: 8 }), {
        format: { series: [{ number: { style: "plain", decimals: 0 } }] },
      }),
    );
    tiles.push(
      tile("Top pages", "bar", "two-thirds", question("google_analytics_pages", [{ label: "Page views", aggregate: "sum", field: "page_views" }], { groupBy: { field: "page_path" }, dateField: "date", sort: { by: "value", direction: "desc" }, limit: 10 }), {
        format: { series: [{ number: { style: "plain", decimals: 0 } }] },
      }),
    );
    tiles.push(
      tile("Sessions by device", "donut", "third", question("google_analytics_devices", [sessions], { groupBy: { field: "device" }, dateField: "date", sort: { by: "value", direction: "desc" } }), {
        format: { donutTotal: true, series: [{ number: { style: "plain", decimals: 0 } }] },
      }),
    );
  }

  if (id === "search") {
    // Google Search Console (decision 1186). Click rate and average position over many rows are
    // worked out from the sums (impressions-weighted, as Google does), never by averaging daily rates.
    const daily = "google_search_console_daily";
    const clicks: Measure = { label: "Clicks", aggregate: "sum", field: "clicks" };
    const impressions: Measure = { label: "Impressions", aggregate: "sum", field: "impressions" };
    const clickRate: Measure = { label: "Click rate", aggregate: "formula", formula: "[Clicks] / [Impressions]", inputs: [{ name: "Clicks", aggregate: "sum", field: "clicks" }, { name: "Impressions", aggregate: "sum", field: "impressions" }] };
    const position: Measure = {
      label: "Average position",
      aggregate: "formula",
      formula: "[Position x impressions] / [Impressions]",
      inputs: [{ name: "Position x impressions", aggregate: "sum", field: "average_position", times: "impressions" }, { name: "Impressions", aggregate: "sum", field: "impressions" }],
    };
    const whole = (suffix?: string): ChartFormat => ({ series: [{ number: { style: "plain", decimals: 0, ...(suffix ? { suffix } : {}) } }] });
    const byValue = { sort: { by: "value" as const, direction: "desc" as const }, dateField: "date" };
    tiles.push(tile("Website search", "text", "full", null, {
      text: "From Google Search Console, loaded nightly. Google's days are Pacific time, its data arrives 2 to 3 days late, and the newest days may still change until Google has finished counting them; Tohyee fetches them again each load. Impressions are the times a link to the site was shown in Google's results; click rate is clicks divided by impressions. Average position is where the site's highest link sat, averaged over every time it was shown: 1 is the top, 10 is usually the bottom of the first page, and lower is better. Google leaves out searches made by very few people, so the searches below add up to less than the totals.",
    }));
    tiles.push(tile("Clicks", "kpi", "quarter", question(daily, [{ ...clicks, compare: "previous_period" }], { dateField: "date", sparkline: true }), { format: whole("clicks") }));
    tiles.push(tile("Impressions", "kpi", "quarter", question(daily, [{ ...impressions, compare: "previous_period" }], { dateField: "date", sparkline: true }), { format: whole("impressions") }));
    tiles.push(tile("Click rate", "kpi", "quarter", question(daily, [clickRate], { dateField: "date" }), { format: { series: [{ number: { style: "percent", decimals: 1 } }] } }));
    tiles.push(tile("Average position", "kpi", "quarter", question(daily, [position], { dateField: "date" }), {
      format: { series: [{ number: { style: "plain", decimals: 1 } }], kpi: { downIsGood: true } },
    }));
    tiles.push(
      tile("Clicks and impressions by week", "combo", "full", question(daily, [clicks, impressions], { groupBy: { field: "date", grain: "week" }, dateField: "date" }), {
        format: { series: [{ as: "bar", number: { style: "plain", decimals: 0 } }, { as: "line", axis: "right", number: { style: "plain", decimals: 0 } }], rightAxis: { title: "Impressions" } },
      }),
    );
    tiles.push(tile("Top searches", "bar", "half", question("google_search_console_queries", [clicks], { groupBy: { field: "query" }, ...byValue, limit: 10 }), { format: whole() }));
    tiles.push(tile("Top pages", "bar", "half", question("google_search_console_pages", [clicks], { groupBy: { field: "page" }, ...byValue, limit: 10 }), { format: whole() }));
    tiles.push(
      tile("Shown a lot, rarely clicked", "table", "full", question("google_search_console_queries", [impressions, clicks, clickRate, position], { groupBy: { field: "query" }, ...byValue, limit: 20 }), {
        format: {
          series: [{ number: { style: "plain", decimals: 0 } }, { number: { style: "plain", decimals: 0 } }, { number: { style: "percent", decimals: 1 } }, { number: { style: "plain", decimals: 1 } }],
          // A click rate under 2% stands out: these searches show the site often but people choose other results.
          conditional: [{ value: 2, apply: "font", by: "rules", rules: [{ op: "<", value: "0.02", color: "#c0392b" }] }],
          card: { subtitle: "The searches the site was shown for most. Red: under 2% clicked, so a clearer page title or description in Google's results may help." },
        },
      }),
    );
    tiles.push(tile("Clicks by country", "bar", "two-thirds", question("google_search_console_countries", [clicks], { groupBy: { field: "country" }, ...byValue, limit: 10 }), { format: whole() }));
    tiles.push(tile("Clicks by device", "donut", "third", question("google_search_console_devices", [clicks], { groupBy: { field: "device" }, ...byValue }), {
      format: { donutTotal: true, series: [{ number: { style: "plain", decimals: 0 } }] },
    }));
  }

  return { name: template.name, description: template.description, settings, tiles };
}
