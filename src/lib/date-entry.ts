/*
 * Typed dates the New Zealand way (#258): day first, with shorthand for fast
 * keyboard entry. Shared with the browser, so no server imports. Returns an
 * ISO date (YYYY-MM-DD), or null when the text isn't a date.
 *
 * - 14/10/2026, 14-10-26, 14.10.2026, 14 10 2026: day, month, year
 * - 14/10, 1410: this year
 * - 141026, 14102026: digits only, day first
 * - 14: the 14th of this month
 * - 2026-10-14: ISO
 * - t or today: today
 * - +14, -3: days from the base date (an invoice's date for its due date), or today
 * - +2w: weeks from the base date
 * - +20m: the 20th of the month after the base date (NZ trade terms); the
 *   last day of that month if it's shorter
 */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function iso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parts(isoDate: string): [number, number, number] {
  const [year, month, day] = isoDate.split("-").map(Number);
  return [year, month, day];
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = parts(isoDate);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** A two-digit year, as people mean it: 00-69 is 2000s, 70-99 is 1900s. */
function fullYear(text: string): number {
  const value = Number(text);
  if (text.length === 4) return value;
  return value < 70 ? 2000 + value : 1900 + value;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && iso(...parts(value)) === value;
}

/**
 * Reads a typed date. `today` is the browser's today (YYYY-MM-DD); `base` is
 * what +14 and +20m count from, when the field has one (a due date counts
 * from its document's date).
 */
export function parseDateEntry(input: string, today: string, base?: string | null): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const from = base && isIsoDate(base) ? base : today;
  const [thisYear, thisMonth] = parts(today);
  if (text === "t" || text === "today") return today;
  let match = /^([+-])\s*(\d{1,4})\s*([dwm]?)$/.exec(text);
  if (match) {
    const count = Number(match[2]) * (match[1] === "-" ? -1 : 1);
    if (match[3] === "w") return addDays(from, count * 7);
    if (match[3] === "m") {
      // +20m: the 20th of the following month (the trade term), clamped to that month's last day.
      if (match[1] === "-" || count < 1 || count > 31) return null;
      const [year, month] = parts(from);
      const nextYear = month === 12 ? year + 1 : year;
      const nextMonth = month === 12 ? 1 : month + 1;
      const last = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
      return iso(nextYear, nextMonth, Math.min(count, last));
    }
    return addDays(from, count);
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return iso(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[/.\- ](\d{1,2})(?:[/.\- ](\d{2}|\d{4}))?$/.exec(text);
  if (match) return iso(match[3] ? fullYear(match[3]) : thisYear, Number(match[2]), Number(match[1]));
  match = /^\d+$/.exec(text);
  if (match) {
    if (text.length <= 2) return iso(thisYear, thisMonth, Number(text));
    if (text.length === 4) return iso(thisYear, Number(text.slice(2, 4)), Number(text.slice(0, 2)));
    if (text.length === 6) return iso(fullYear(text.slice(4, 6)), Number(text.slice(2, 4)), Number(text.slice(0, 2)));
    if (text.length === 8) return iso(Number(text.slice(4, 8)), Number(text.slice(2, 4)), Number(text.slice(0, 2)));
  }
  return null;
}

/** An ISO date shown day first: 14/10/2026. */
export function showDateEntry(value: string): string {
  if (!isIsoDate(value)) return value;
  const [year, month, day] = parts(value);
  return `${pad(day)}/${pad(month)}/${year}`;
}
