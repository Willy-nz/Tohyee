/**
 * CSV cells for every export (decision 109, #148): quoted when needed (a
 * comma, quote, line break, or space at either end), and text a spreadsheet
 * would run as a formula (starting =, +, -, @, tab or carriage return) gets
 * an apostrophe first, unless it's a plain number like -12.50. Imports take
 * that one apostrophe off again (`fromCsvCell`), so an exported file can be
 * edited and brought back in (IM16).
 */
const NUMBER = /^-?\d+(\.\d+)?$/;
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA.test(text) && !NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows to CSV text, CR LF after every line. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** A cell read back from a CSV Tohyee made: the apostrophe that kept it from running as a formula comes off. */
export function fromCsvCell(text: string): string {
  return text.startsWith("'") && FORMULA.test(text.slice(1)) && !NUMBER.test(text.slice(1)) ? text.slice(1) : text;
}
