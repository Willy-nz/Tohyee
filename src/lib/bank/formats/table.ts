import {
  type DateOrder,
  makeLine,
  type ParsedStatementLine,
  parseBankAmount,
  parseBankDate,
  RowError,
} from "@/lib/bank/formats/common";
import { isSupportedCurrency } from "@/lib/money/currency";

/**
 * Statements that arrive as a table (CSV or Excel): which row holds the
 * headings, which column is which, how dates are written and whether the
 * bank shows money out as positive (some credit card exports do). A layout is
 * saved per bank account so the next import from that bank just works.
 */
export const LAYOUT_FIELDS = [
  "date",
  "amount",
  "debit",
  "credit",
  "description",
  "payee",
  "particulars",
  "code",
  "reference",
  "type",
  "balance",
  "id",
  "currency",
] as const;
export type LayoutField = (typeof LAYOUT_FIELDS)[number];

export const LAYOUT_FIELD_LABELS: Readonly<Record<LayoutField, string>> = {
  date: "Date",
  amount: "Amount (money in positive)",
  debit: "Money out",
  credit: "Money in",
  description: "Description",
  payee: "Payee / other party",
  particulars: "Particulars",
  code: "Code",
  reference: "Reference",
  type: "Transaction type",
  balance: "Balance",
  id: "Transaction id",
  currency: "Currency",
};

export type TableLayout = {
  /** Index of the heading row, or -1 when the file has no headings. */
  headerRow: number;
  /** Column headings (or "Column N" without headings) for each field that's used. */
  columns: Partial<Record<LayoutField, string>>;
  dateOrder: DateOrder;
  /** Money out is shown as positive and money in as negative: flip every amount. */
  invertAmounts: boolean;
};

export type TableReadResult = {
  headers: string[];
  layout: TableLayout;
  lines: ParsedStatementLine[];
  errors: string[];
  /** Currencies the file says it's in (a currency column, or an amount heading like "Amount (USD)"). */
  currencies: string[];
};

const HEADER_NAMES: Record<LayoutField, string[]> = {
  date: ["date", "transaction date", "processed date", "posted date", "posting date", "trans date", "date processed", "booking date", "value date", "transaction_date", "txn date"],
  amount: ["amount", "amount (nzd)", "amount nzd", "transaction amount", "amt", "value", "nzd amount"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "money out", "paid out", "debit amount", "amount out"],
  credit: ["credit", "credits", "deposit", "deposits", "money in", "paid in", "credit amount", "amount in"],
  description: ["description", "details", "transaction details", "narrative", "memo", "transaction description"],
  payee: ["payee", "other party", "other party name", "name", "to/from", "merchant", "merchant name", "payer/payee"],
  particulars: ["particulars"],
  code: ["code", "analysis code"],
  reference: ["reference", "ref", "their reference", "your reference"],
  type: ["type", "transaction type", "tran type", "trans type"],
  balance: ["balance", "running balance", "closing balance", "account balance"],
  id: ["unique id", "transaction id", "id", "fitid", "tran id", "transaction reference number"],
  currency: ["currency", "ccy", "currency code", "curr"],
};

/** A currency named in an amount heading: "Amount (USD)", "USD amount", "Amount NZD". */
function headingCurrency(header: string | undefined): string | null {
  if (!header) return null;
  const text = normalise(header);
  const match = /\(([a-z]{3})\)/.exec(text) ?? /^([a-z]{3}) (?:amount|debit|credit)$/.exec(text) ?? /^(?:amount|debit|credit) ([a-z]{3})$/.exec(text);
  const code = match?.[1].toUpperCase();
  return code && isSupportedCurrency(code) ? code : null;
}

function normalise(header: string): string {
  return header.replace(/\s+/g, " ").trim().toLowerCase();
}

function headersFor(rows: string[][], headerRow: number): string[] {
  const width = Math.max(0, ...rows.slice(Math.max(headerRow, 0), Math.max(headerRow, 0) + 50).map((row) => row.length));
  if (headerRow >= 0) {
    const row = rows[headerRow] ?? [];
    return Array.from({ length: width }, (_, index) => {
      const text = (row[index] ?? "").trim();
      return text || `Column ${index + 1}`;
    });
  }
  return Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
}

function matchHeaders(headers: string[]): Partial<Record<LayoutField, string>> {
  const columns: Partial<Record<LayoutField, string>> = {};
  const used = new Set<string>();
  for (const field of LAYOUT_FIELDS) {
    const found = headers.find(
      (header) =>
        !used.has(header) &&
        (HEADER_NAMES[field].includes(normalise(header)) ||
          // "Amount (USD)", "USD amount": an amount heading that names its currency (FXB10).
          (field === "amount" && /amount/.test(normalise(header)) && headingCurrency(header) !== null)),
    );
    if (found) {
      columns[field] = found;
      used.add(found);
    }
  }
  return columns;
}

/** Days first unless a date in the column only makes sense month first. */
function guessDateOrder(values: string[]): DateOrder {
  let dayFirst = false;
  let monthFirst = false;
  for (const value of values) {
    const match = /^(\d{1,2})[-/. ](\d{1,2})[-/. ]\d{2,4}/.exec(value.trim());
    if (!match) continue;
    if (Number(match[1]) > 12) dayFirst = true;
    if (Number(match[2]) > 12) monthFirst = true;
  }
  return monthFirst && !dayFirst ? "mdy" : "dmy";
}

/**
 * Works out a layout: the heading row is the first of the top 30 rows with a
 * date heading and an amount (or money in/out) heading. Without headings, the
 * date column is the first whose cells are mostly dates and the amount column
 * the first other one whose cells are mostly amounts.
 */
export function detectLayout(rows: string[][]): TableLayout {
  for (let index = 0; index < Math.min(rows.length, 30); index += 1) {
    const headers = headersFor(rows, index);
    const columns = matchHeaders(headers);
    if (columns.date && (columns.amount || columns.debit || columns.credit)) {
      const dates = rows.slice(index + 1, index + 200).map((row) => row[headers.indexOf(columns.date!)] ?? "");
      return { headerRow: index, columns, dateOrder: guessDateOrder(dates), invertAmounts: false };
    }
  }
  const sample = rows.slice(0, 200);
  const headers = headersFor(rows, -1);
  const share = (index: number, test: (value: string) => boolean) => {
    const values = sample.map((row) => (row[index] ?? "").trim()).filter(Boolean);
    return values.length === 0 ? 0 : values.filter(test).length / values.length;
  };
  const isAmount = (value: string) => {
    try {
      return parseBankAmount(value) !== null && /\d/.test(value) && !/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(value);
    } catch {
      return false;
    }
  };
  const dateIndex = headers.findIndex((_, index) => share(index, (value) => parseBankDate(value) !== null) > 0.8);
  const amountIndex = headers.findIndex((_, index) => index !== dateIndex && share(index, isAmount) > 0.8);
  const columns: Partial<Record<LayoutField, string>> = {};
  if (dateIndex >= 0) columns.date = headers[dateIndex];
  if (amountIndex >= 0) columns.amount = headers[amountIndex];
  const textIndex = headers.findIndex(
    (_, index) => index !== dateIndex && index !== amountIndex && share(index, (value) => /[A-Za-z]/.test(value)) > 0.5,
  );
  if (textIndex >= 0) columns.description = headers[textIndex];
  const dates = dateIndex >= 0 ? sample.map((row) => row[dateIndex] ?? "") : [];
  return { headerRow: -1, columns, dateOrder: guessDateOrder(dates), invertAmounts: false };
}

/** Checks a layout that came from the browser or a saved setting. */
export function parseLayout(input: unknown): TableLayout | null {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new RowError("The column layout must be an object.");
  }
  const record = input as Record<string, unknown>;
  const headerRow = Number(record.headerRow);
  if (!Number.isInteger(headerRow) || headerRow < -1 || headerRow > 10_000) {
    throw new RowError("The heading row must be a row number, or -1 for no headings.");
  }
  const columnsInput = (record.columns ?? {}) as Record<string, unknown>;
  const columns: Partial<Record<LayoutField, string>> = {};
  for (const field of LAYOUT_FIELDS) {
    const value = columnsInput[field];
    if (typeof value === "string" && value.trim()) columns[field] = value.trim().slice(0, 200);
  }
  const dateOrder = record.dateOrder === "mdy" || record.dateOrder === "ymd" ? record.dateOrder : "dmy";
  return { headerRow, columns, dateOrder, invertAmounts: record.invertAmounts === true };
}

function negate(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}

/** Reads the transactions out of table rows with a layout. Rows without a date or an amount are skipped. */
export function readTable(rows: string[][], layoutInput?: TableLayout | null): TableReadResult {
  const layout = layoutInput ?? detectLayout(rows);
  const headers = headersFor(rows, layout.headerRow);
  const errors: string[] = [];
  const column = (field: LayoutField) => {
    const name = layout.columns[field];
    return name ? headers.indexOf(name) : -1;
  };
  const index = Object.fromEntries(LAYOUT_FIELDS.map((field) => [field, column(field)])) as Record<LayoutField, number>;
  for (const field of LAYOUT_FIELDS) {
    if (layout.columns[field] && index[field] < 0) {
      errors.push(`The file has no "${layout.columns[field]}" column for ${field}.`);
    }
  }
  if (index.date < 0) errors.push("Choose the date column.");
  if (index.amount < 0 && index.debit < 0 && index.credit < 0) errors.push("Choose the amount column, or the money in and out columns.");
  const lines: ParsedStatementLine[] = [];
  const currencies = new Set<string>();
  if (errors.length > 0) return { headers, layout, lines, errors, currencies: [] };
  for (const field of ["amount", "debit", "credit"] as const) {
    const code = headingCurrency(layout.columns[field]);
    if (code) currencies.add(code);
  }

  const cell = (row: string[], field: LayoutField) => (index[field] >= 0 ? (row[index[field]] ?? "").trim() : "");
  rows.forEach((row, rowIndex) => {
    if (rowIndex <= layout.headerRow) return;
    const dateText = cell(row, "date");
    const amountText = cell(row, "amount");
    const debitText = cell(row, "debit");
    const creditText = cell(row, "credit");
    if (!dateText && !amountText && !debitText && !creditText) return;
    const label = `Row ${rowIndex + 1}`;
    try {
      const date = parseBankDate(dateText, layout.dateOrder);
      if (!date) {
        // Summary rows ("Closing balance", totals) have text where the date should be and nothing else useful.
        if (!/\d/.test(dateText)) return;
        throw new RowError(`"${dateText}" isn't a date.`);
      }
      let amount: string | null;
      if (index.amount >= 0) {
        amount = parseBankAmount(amountText);
      } else {
        const debit = parseBankAmount(debitText);
        const credit = parseBankAmount(creditText);
        if (debit && credit && !/^-?0\.00$/.test(debit) && !/^-?0\.00$/.test(credit)) {
          throw new RowError("has both money in and money out.");
        }
        if (debit && !/^-?0\.00$/.test(debit)) amount = debit.startsWith("-") ? debit : negate(debit);
        else amount = credit ? (credit.startsWith("-") ? negate(credit) : credit) : null;
      }
      if (amount === null) throw new RowError("has no amount.");
      if (/^-?0\.00$/.test(amount)) return;
      if (layout.invertAmounts) amount = negate(amount);
      const currencyText = cell(row, "currency").toUpperCase();
      if (currencyText) {
        if (!/^[A-Z]{3}$/.test(currencyText)) throw new RowError(`"${cell(row, "currency")}" isn't a currency code.`);
        currencies.add(currencyText);
      }
      const balanceText = cell(row, "balance");
      lines.push(
        makeLine({
          date,
          amount,
          description: cell(row, "description") || null,
          payee: cell(row, "payee") || null,
          particulars: cell(row, "particulars") || null,
          code: cell(row, "code") || null,
          reference: cell(row, "reference") || null,
          balance: balanceText ? parseBankAmount(balanceText) : null,
          externalId: cell(row, "id") ? `row:${cell(row, "id")}` : null,
          extra: cell(row, "description") ? [cell(row, "payee"), cell(row, "particulars"), cell(row, "code"), cell(row, "reference")] : [cell(row, "type")],
        }),
      );
    } catch (error) {
      if (error instanceof RowError) {
        errors.push(`${label}: ${error.message}`);
        return;
      }
      throw error;
    }
  });
  return { headers, layout, lines, errors, currencies: [...currencies].sort() };
}

/** Splits CSV (or semicolon, tab or pipe separated) text into rows, following RFC 4180 quoting. */
export function parseDelimited(text: string, options: { keepBlankRows?: boolean } = {}): string[][] {
  const sample = text.split(/\r?\n/).slice(0, 30);
  const delimiter = [",", ";", "\t", "|"]
    .map((candidate) => {
      const counts = sample.filter(Boolean).map((line) => line.split(candidate).length);
      const common = counts.length ? Math.max(...counts) : 1;
      const agreeing = counts.filter((count) => count === common && count > 1).length;
      return { candidate, agreeing, common };
    })
    .sort((a, b) => b.agreeing - a.agreeing || b.common - a.common)[0].candidate;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field.trim() === "") {
      field = "";
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Imports keep blank rows so the row numbers they report are the spreadsheet's.
  return options.keepBlankRows ? rows : rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}
