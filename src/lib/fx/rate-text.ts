import { ValidationError } from "@/lib/errors";

/**
 * Several exchange rates pasted at once (example MC52): one per line,
 * "currency, effective date, rate" and an optional note, separated by commas
 * or tabs (so rows copied from a spreadsheet work). Dates are YYYY-MM-DD or
 * DD/MM/YYYY. A first line starting with "currency" is a heading and is
 * skipped, as are blank lines. Nothing here checks the values themselves;
 * the service does, line by line.
 */
/**
 * The list's entry in effect for a currency on a date (MC48, MC53): the
 * latest effective date on or before it; `rates` newest first, as the list
 * comes (archived entries left out). Browser-safe, for the revaluation
 * screen's closing-rate suggestion.
 */
export function rateInEffect<T extends { currencyCode: string; effectiveDate: string; archivedAt: string | null }>(
  rates: readonly T[],
  currencyCode: string,
  date: string,
): T | null {
  return rates.find((rate) => rate.archivedAt === null && rate.currencyCode === currencyCode && rate.effectiveDate <= date) ?? null;
}

export type PastedRate ={ line: number; currencyCode: string; effectiveDate: string; rate: string; note: string | null };

const NZ_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isoDate(text: string): string {
  const nz = NZ_DATE.exec(text);
  if (!nz) return text;
  return `${nz[3]}-${nz[2].padStart(2, "0")}-${nz[1].padStart(2, "0")}`;
}

export function parsePastedRates(text: unknown): PastedRate[] {
  if (typeof text !== "string" || !text.trim()) throw new ValidationError("Paste at least one rate: currency, effective date, rate.");
  const rows: PastedRate[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    const cells = raw.split(raw.includes("\t") ? "\t" : ",").map((cell) => cell.trim());
    if (rows.length === 0 && /^currency/i.test(cells[0] ?? "")) return;
    if (cells.length < 3 || cells.length > 4 || cells.slice(0, 3).some((cell) => cell === "")) {
      throw new ValidationError(`Line ${line}: expected currency, effective date, rate (and an optional note), like "USD, 2026-08-31, 1.6543".`);
    }
    rows.push({ line, currencyCode: cells[0], effectiveDate: isoDate(cells[1]), rate: cells[2], note: cells[3] ? cells[3] : null });
  });
  if (rows.length === 0) throw new ValidationError("Paste at least one rate: currency, effective date, rate.");
  if (rows.length > 500) throw new ValidationError("Paste at most 500 rates at a time.");
  return rows;
}
