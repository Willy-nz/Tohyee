import { formatMoney } from "@/lib/format";
import { dec, mul, toPlainString } from "@/lib/money/decimal";

/**
 * How document lines show rates and unit prices, shared by the screens, the
 * printed page and the PDF (browser-safe), so they can't differ.
 */

/** A tax rate stored as a fraction: "0.15" -> "15%". */
export function formatRate(rate: string): string {
  return `${toPlainString(mul(dec(rate), dec("100")))}%`;
}

/** Unit prices keep the places they were entered with (2 to 4): "50" -> "50.00", "3.3333" stays. */
export function formatUnitPrice(value: string): string {
  const places = value.split(".")[1]?.length ?? 0;
  return formatMoney(value, Math.max(2, places));
}
