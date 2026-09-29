/**
 * Display formatting that works on the decimal strings the API returns,
 * without ever converting money to a floating-point number.
 */

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1234.5" -> "1,234.50"; negative values get a leading minus. */
export function formatMoney(value: string | null | undefined, decimals = 2): string {
  if (value == null || value === "") return "";
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  let fixedFraction = fraction.padEnd(decimals, "0");
  let fixedWhole = whole;
  if (fixedFraction.length > decimals) {
    // Display-only rounding (half up) for values with extra places.
    const cents = BigInt(`${whole}${fixedFraction.slice(0, decimals)}`) + (Number(fixedFraction[decimals]) >= 5 ? BigInt(1) : BigInt(0));
    const text = cents.toString().padStart(decimals + 1, "0");
    fixedWhole = text.slice(0, text.length - decimals);
    fixedFraction = text.slice(text.length - decimals);
  }
  const isZero = /^0*$/.test(fixedWhole) && /^0*$/.test(fixedFraction);
  const body = decimals > 0 ? `${groupThousands(fixedWhole)}.${fixedFraction}` : groupThousands(fixedWhole);
  return negative && !isZero ? `-${body}` : body;
}

/** Quantities: trims trailing zeros, keeps up to 4 places. */
export function formatQuantity(value: string | null | undefined): string {
  if (value == null || value === "") return "";
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const [whole, fraction = ""] = trimmed.split(".");
  const cleanFraction = fraction.replace(/0+$/, "");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  return `${negative ? "-" : ""}${groupThousands(digits)}${cleanFraction ? `.${cleanFraction}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-15" -> "15 Jun 2026". Works on the string, so no time-zone shifts. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Today's date in the browser's time zone, as YYYY-MM-DD. */
export function todayInBrowser(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** GST numbers are stored as digits: "123456789" -> "123-456-789", "12345678" -> "12-345-678". */
export function formatGstNumber(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^(\d{2,3})(\d{3})(\d{3})$/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}

/**
 * Who did something, for screens: `personName(bill, "createdBy")` gives
 * `createdByName` (the person's name, which the server adds beside every
 * person's email) or, failing that, `createdByEmail`.
 */
export function personName<P extends string>(record: { [K in `${P}Email`]?: string | null }, prefix: P): string | null {
  const values = record as Record<string, unknown>;
  const name = values[`${prefix}Name`];
  if (typeof name === "string" && name) return name;
  const email = values[`${prefix}Email`];
  return typeof email === "string" ? email : null;
}
