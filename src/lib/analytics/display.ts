import type { ResultColumn } from "@/lib/analytics/query";
import { formatCurrency, formatDate, formatMoney, formatQuantity } from "@/lib/format";

/**
 * A value from a query, shown the way its column is meant to be read, in
 * tables, key figures and pivot tables alike. Never turned into a JS number.
 * Money has the minus first, as everywhere else in Tohyee: -$27.00 (#328).
 */
export function showValue(value: string | null, column: Pick<ResultColumn, "format">): string {
  if (value === null) return "";
  switch (column.format) {
    case "money":
      return formatCurrency(value);
    case "number":
      return formatQuantity(formatMoney(value, 4));
    case "integer":
      return formatQuantity(value);
    case "date":
      return formatDate(value);
    default:
      return value;
  }
}
