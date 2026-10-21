import type { AppliesToKey } from "@/lib/tax/income/allocation-kinds";

/*
 * Browser-safe parts of importing IRD account files (examples ITX-IMP1 to
 * ITX-IMP12, decisions 710-716; Codex, delegated by owner, 20 October 2026).
 *
 * IRD doesn't publish the columns of a myIR download, so Tohyee doesn't
 * assume any: the person says which column is which, and what each value in
 * the "type" and "instalment" columns means, with a preview. The mapping can
 * be saved and is offered again for a file with the same headings.
 */

export const IRD_ROW_KINDS = ["payment", "assessment", "credit", "interest", "penalty", "refund", "other"] as const;
export type IrdRowKind = (typeof IRD_ROW_KINDS)[number];

export const IRD_ROW_KIND_LABELS: Record<IrdRowKind, string> = {
  payment: "Payment",
  assessment: "Assessment",
  credit: "Credit (transfer or adjustment)",
  interest: "Interest",
  penalty: "Penalty",
  refund: "Refund",
  other: "Other (recorded only)",
};

export const IRD_IMPORT_SOURCES = ["myir_export", "other_spreadsheet"] as const;
export type IrdImportSource = (typeof IRD_IMPORT_SOURCES)[number];
export const IRD_IMPORT_SOURCE_LABELS: Record<IrdImportSource, string> = {
  myir_export: "Downloaded from myIR (IRD's own file)",
  other_spreadsheet: "Another spreadsheet (typed up from myIR, or from an accountant)",
};

export const IRD_IMPORT_COLUMNS = ["date", "effectiveDate", "amount", "debit", "credit", "type", "description", "period", "appliesTo", "reference"] as const;
export type IrdImportColumn = (typeof IRD_IMPORT_COLUMNS)[number];

export const IRD_IMPORT_COLUMN_LABELS: Record<IrdImportColumn, { label: string; hint: string }> = {
  date: { label: "Date", hint: "Required. The date of each transaction." },
  effectiveDate: { label: "Effective date", hint: "Only if the file has IRD's effective date as well." },
  amount: { label: "Amount", hint: "One amount column with a sign. Or use Debit and Credit instead." },
  debit: { label: "Debit (you owe)", hint: "Assessments, interest and penalties, usually." },
  credit: { label: "Credit (you paid or were credited)", hint: "Payments and credits, usually." },
  type: { label: "Type or transaction", hint: "Says what each row is, e.g. a payment or interest." },
  description: { label: "Description", hint: "Kept with the row." },
  period: { label: "Period or income year", hint: "E.g. 31/03/2027 or 2027. Without it, choose the income year for the whole file." },
  appliesTo: { label: "Instalment", hint: "Only if the file says which instalment a payment is for." },
  reference: { label: "Reference", hint: "Kept with the row." },
};

export const DATE_ORDERS = ["dmy", "mdy", "ymd"] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];
export const DATE_ORDER_LABELS: Record<DateOrder, string> = { dmy: "Day first (31/03/2027)", mdy: "Month first (03/31/2027)", ymd: "Year first (2027-03-31)" };

export const AMOUNT_SIGNS = ["positive_is_debit", "positive_is_credit"] as const;
export type AmountSign = (typeof AMOUNT_SIGNS)[number];
export const AMOUNT_SIGN_LABELS: Record<AmountSign, string> = {
  positive_is_debit: "A positive amount is something you owe (a debit)",
  positive_is_credit: "A positive amount is a payment or credit to you",
};

export type IrdImportMapping = {
  /** Where the headings are (0-based). */
  headerRow: number;
  /** Column headings, by field. Date is needed; and Amount, or Debit and/or Credit. */
  columns: Partial<Record<IrdImportColumn, string>>;
  dateOrder: DateOrder;
  /** With one Amount column: which way round it is. */
  amountSign?: AmountSign;
  /** What each value of the Type column is, by `valueKey`; "skip" leaves those rows out. */
  kindValues: Record<string, IrdRowKind | "skip">;
  /** Without a Type column: what every row is. */
  defaultKind?: IrdRowKind;
  /** Which instalment each value of the Instalment column means, by `valueKey`; "none" when it doesn't say. */
  appliesToValues: Record<string, AppliesToKey | "none">;
};

/** How a cell value is compared for the value mappings: case, spaces and surrounding blanks ignored. */
export function valueKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Column headings, with "Column N" for blank ones and "(2)" for repeats, so every column can be picked. */
export function headingsAt(rows: readonly string[][], headerRow: number): string[] {
  const width = Math.max(0, ...rows.slice(headerRow, headerRow + 200).map((row) => row.length));
  const header = rows[headerRow] ?? [];
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, index) => {
    const text = (header[index] ?? "").trim() || `Column ${index + 1}`;
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return count === 1 ? text : `${text} (${count})`;
  });
}

/**
 * A first guess at the headings row: the first of the first 20 rows with two
 * or more cells that are text, not numbers or dates (exports often start with
 * a title line). The person can change it.
 */
export function guessHeaderRow(rows: readonly string[][]): number {
  const texty = (cell: string) => cell.trim() !== "" && !/^[-+($]*[\d.,/:\s-]+[)]?$/.test(cell.trim());
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const cells = rows[index].filter((cell) => cell.trim() !== "");
    if (cells.length >= 2 && cells.every(texty)) return index;
  }
  return Math.max(
    0,
    rows.findIndex((row) => row.some((cell) => cell.trim() !== "")),
  );
}

/** The row whose headings are exactly these (a saved mapping's), or null. */
export function findHeadings(rows: readonly string[][], headings: readonly string[]): number | null {
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const found = headingsAt(rows, index);
    if (found.length === headings.length && found.every((heading, position) => valueKey(heading) === valueKey(headings[position]))) return index;
  }
  return null;
}

/**
 * The different values in a column below the headings, with how many rows
 * have each (blank counts as ""), in the order they first appear.
 */
export function distinctValues(rows: readonly string[][], headerRow: number, heading: string | undefined): Array<{ key: string; text: string; count: number }> {
  if (!heading) return [];
  const column = headingsAt(rows, headerRow).indexOf(heading);
  if (column < 0) return [];
  const found = new Map<string, { key: string; text: string; count: number }>();
  for (const row of rows.slice(headerRow + 1)) {
    if (!row.some((cell) => cell.trim() !== "")) continue;
    const text = (row[column] ?? "").trim();
    const key = valueKey(text);
    const entry = found.get(key) ?? { key, text, count: 0 };
    entry.count += 1;
    found.set(key, entry);
  }
  return [...found.values()];
}

/**
 * A suggestion for what a Type value is, from plain words in it ("Payment",
 * "Interest", "Late payment penalty"). Only a suggestion: the person sees it
 * and can change it, and nothing is imported until they've checked the rows.
 * Null when the words don't say.
 */
export function suggestKind(text: string): IrdRowKind | null {
  const value = valueKey(text);
  if (!value) return null;
  if (/penalt/.test(value)) return "penalty";
  if (/interest/.test(value)) return "interest";
  if (/refund/.test(value)) return "refund";
  if (/assess/.test(value)) return "assessment";
  if (/payment|paid/.test(value)) return "payment";
  if (/credit|transfer/.test(value)) return "credit";
  return null;
}

/** "Instalment 2", "installment 2", "P2"… are suggested as that instalment; nothing else is. */
export function suggestAppliesTo(text: string): AppliesToKey | null {
  const value = valueKey(text);
  const match = /^(?:instal+ment|p)\s*([123])$/.exec(value);
  return match ? (`instalment_${match[1]}` as AppliesToKey) : null;
}
