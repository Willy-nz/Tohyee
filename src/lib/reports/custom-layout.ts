import type { AccountType } from "@/lib/accounts/types";

/**
 * Custom reports (examples CR1-CR10): the layout a user edits, and the
 * figures worked out from it. Browser-safe: no server imports, so the editor
 * can build and change layouts with the same types.
 */
export type CustomReportBase = "profit_and_loss" | "balance_sheet";
export type PeriodLength = "month" | "quarter" | "year";

export const CUSTOM_REPORT_BASES: Record<CustomReportBase, string> = {
  profit_and_loss: "Profit and loss",
  balance_sheet: "Balance sheet",
};

export const PERIOD_LENGTHS: Record<PeriodLength, { label: string; months: number }> = {
  month: { label: "Months", months: 1 },
  quarter: { label: "Quarters", months: 3 },
  year: { label: "Years", months: 12 },
};

export const CUSTOM_REPORT_LIMITS = {
  titleLength: 200,
  labelLength: 200,
  noteLength: 5000,
  blocks: 20,
  rowsPerTable: 100,
  periods: 12,
  termsPerFormula: 50,
  accountCodesPerGroup: 200,
} as const;

export type ReportColumnsSetting = {
  /** The last day of a month: the newest column ends here. */
  periodEnd: string;
  periodLength: PeriodLength;
  periodCount: number;
  /** First column less the second. */
  difference: boolean;
  /** The difference as a % of the second column (needs `difference`). */
  percent: boolean;
  /** Profit and loss only: from the start of the financial year to `periodEnd`. */
  yearToDate: boolean;
};

export type FormulaTerm = { rowId: string; sign: 1 | -1 };

export type ReportRow =
  | { id: string; kind: "heading"; label: string }
  | {
      id: string;
      kind: "group";
      label: string;
      /** Used when `accountCodes` is empty. */
      accountTypes: AccountType[];
      /** When not empty, exactly these accounts. */
      accountCodes: string[];
      showAccounts: boolean;
    }
  | { id: string; kind: "formula"; label: string; terms: FormulaTerm[] }
  | { id: string; kind: "earnings"; label: string; which: "previous" | "current" };

export type ReportBlock =
  | { id: string; kind: "table"; title: string; rows: ReportRow[] }
  | { id: string; kind: "text"; text: string };

/** Profit and loss only: count just the lines tagged with this value or a value under it (TC8). */
export type ReportTrackingFilter = { categoryId: string; valueId: string };

export type CustomReportLayout = {
  title: string;
  columns: ReportColumnsSetting;
  blocks: ReportBlock[];
  filter?: ReportTrackingFilter | null;
};

export type ReportColumnKind = "period" | "difference" | "percent" | "year_to_date";

export type ReportColumn = {
  key: string;
  kind: ReportColumnKind;
  label: string;
  /** Profit and loss periods and year to date; null on a balance sheet (as at `to`). */
  from: string | null;
  to: string | null;
};

/** Amounts as strings, keyed by column; null for a % that can't be worked out (the compared amount is 0.00). */
export type ReportValues = Record<string, string | null>;

export type ComputedLine = { code: string; name: string; values: ReportValues };

export type ComputedRow = {
  id: string;
  kind: ReportRow["kind"];
  label: string;
  values: ReportValues;
  showAccounts: boolean;
  lines: ComputedLine[];
};

export type ComputedBlock =
  | { id: string; kind: "table"; title: string; rows: ComputedRow[] }
  | { id: string; kind: "text"; text: string };

export type CustomReportFigures = {
  title: string;
  base: CustomReportBase;
  currencyCode: string;
  columns: ReportColumn[];
  blocks: ComputedBlock[];
  /** Accounts with a balance that no group includes. */
  notInReport: ComputedLine[];
  /** Accounts with a balance that more than one group of the same table includes. */
  inSeveralGroups: Array<{ tableTitle: string; code: string; name: string; groups: string[] }>;
  /** The tracking filter, as shown on the report, e.g. "Location: Otago" (TC8). */
  filterLabel?: string | null;
  computedAt: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Months since year 0, for stepping back through periods. */
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function monthStart(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

export function monthEnd(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(days).padStart(2, "0")}`;
}

/** The last day of the month `date` is in. */
export function lastDayOfMonth(date: string): string {
  return monthEnd(monthIndex(date));
}

function monthLabel(index: number): string {
  return `${MONTHS[index % 12]} ${Math.floor(index / 12)}`;
}

function dayLabel(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The period columns, newest first (CR2, CR3, CR6). */
export function periodColumns(base: CustomReportBase, setting: ReportColumnsSetting): ReportColumn[] {
  const months = PERIOD_LENGTHS[setting.periodLength].months;
  const last = monthIndex(setting.periodEnd);
  const columns: ReportColumn[] = [];
  for (let i = 0; i < setting.periodCount; i += 1) {
    const endIndex = last - i * months;
    const startIndex = endIndex - months + 1;
    const to = monthEnd(endIndex);
    let label: string;
    if (base === "balance_sheet") label = dayLabel(to);
    else if (months === 1) label = monthLabel(endIndex);
    else if (Math.floor(startIndex / 12) === Math.floor(endIndex / 12)) label = `${MONTHS[startIndex % 12]} - ${monthLabel(endIndex)}`;
    else label = `${monthLabel(startIndex)} - ${monthLabel(endIndex)}`;
    columns.push({
      key: `p${i}`,
      kind: "period",
      label,
      from: base === "balance_sheet" ? null : monthStart(startIndex),
      to,
    });
  }
  return columns;
}

let counter = 0;
/** A short id for a new row or block, unique within a report. */
export function newLayoutId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** A new custom report starts as a copy of the standard report (CR1, CR6). */
export function templateLayout(base: CustomReportBase, periodEnd: string): CustomReportLayout {
  const columns: ReportColumnsSetting = {
    periodEnd: lastDayOfMonth(periodEnd),
    periodLength: "month",
    periodCount: 1,
    difference: false,
    percent: false,
    yearToDate: false,
  };
  const group = (id: string, label: string, accountTypes: AccountType[]): ReportRow => ({
    id,
    kind: "group",
    label,
    accountTypes,
    accountCodes: [],
    showAccounts: true,
  });
  if (base === "profit_and_loss") {
    return {
      title: CUSTOM_REPORT_BASES[base],
      columns,
      blocks: [
        {
          id: "main",
          kind: "table",
          title: "",
          rows: [
            group("revenue", "Revenue", ["revenue"]),
            group("cost_of_sales", "Cost of sales", ["direct_costs"]),
            { id: "gross_profit", kind: "formula", label: "Gross profit", terms: [{ rowId: "revenue", sign: 1 }, { rowId: "cost_of_sales", sign: -1 }] },
            group("other_income", "Other income", ["other_income"]),
            group("expenses", "Expenses", ["expense", "depreciation"]),
            {
              id: "net_profit",
              kind: "formula",
              label: "Net profit",
              terms: [
                { rowId: "gross_profit", sign: 1 },
                { rowId: "other_income", sign: 1 },
                { rowId: "expenses", sign: -1 },
              ],
            },
          ],
        },
      ],
    };
  }
  return {
    title: CUSTOM_REPORT_BASES[base],
    columns,
    blocks: [
      {
        id: "main",
        kind: "table",
        title: "",
        rows: [
          group("assets", "Assets", ["bank", "current_asset", "inventory", "fixed_asset", "non_current_asset"]),
          group("liabilities", "Liabilities", ["credit_card", "current_liability", "non_current_liability"]),
          { id: "net_assets", kind: "formula", label: "Net assets", terms: [{ rowId: "assets", sign: 1 }, { rowId: "liabilities", sign: -1 }] },
          group("equity", "Equity accounts", ["equity"]),
          { id: "previous_earnings", kind: "earnings", label: "Earnings from previous years", which: "previous" },
          { id: "current_earnings", kind: "earnings", label: "Current year earnings", which: "current" },
          {
            id: "total_equity",
            kind: "formula",
            label: "Total equity",
            terms: [
              { rowId: "equity", sign: 1 },
              { rowId: "previous_earnings", sign: 1 },
              { rowId: "current_earnings", sign: 1 },
            ],
          },
        ],
      },
    ],
  };
}
