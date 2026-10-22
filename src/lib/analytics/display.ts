import type { ResultColumn } from "@/lib/analytics/query";
import { formatCurrency, formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { dec, mul, roundHalfUp, toFixedString } from "@/lib/money/decimal";

/**
 * A value from a query, shown the way its column is meant to be read, in
 * tables, key figures and pivot tables alike. Never turned into a JS number.
 * Money has the minus first, as everywhere else in Tohyee: -$27.00 (#328).
 * True and false are Yes and No (decision 577).
 */
export function showValue(value: string | null, column: Pick<ResultColumn, "format">): string {
  if (value === null) return "";
  switch (column.format) {
    case "money":
      return formatCurrency(value);
    case "number":
      // Rounded to 4 places, then trailing zeros dropped (the grouping commas come off first, or 1,203.0000 stayed as it was).
      return formatQuantity(formatMoney(value, 4).replaceAll(",", ""));
    case "integer":
      return formatQuantity(value);
    case "date":
      return formatDate(value);
    case "boolean":
      return booleanText(value);
    case "percent":
      // A share as a fraction (0.250000 is 25.0%, decision 770), to one place, worked out exactly.
      return `${formatQuantity(toFixedString(roundHalfUp(mul(dec(value), dec("100")), 1), 1))}%`;
    default:
      return value;
  }
}

/** "true" -> "Yes", "false" -> "No"; anything else as it is. */
export function booleanText(value: string): string {
  return value === "true" ? "Yes" : value === "false" ? "No" : value;
}
