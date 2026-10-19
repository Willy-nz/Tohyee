import type { ColumnInfo, Filter, FilterOp } from "@/lib/analytics/query";

/**
 * Which tests a tile filter offers for each kind of column, and what each
 * needs typed (decision 578). Browser-safe; the server checks the same rules
 * when the tile is saved or run (parseTileQuery).
 */

export type ColumnKind = "text" | "number" | "date" | "boolean";
export type ValueKind = "none" | "one" | "list" | "two" | "count";

export function columnKind(type: string): ColumnKind {
  if (type === "BOOLEAN") return "boolean";
  if (type === "DATE" || type.startsWith("TIMESTAMP")) return "date";
  if (/^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|DOUBLE|FLOAT|UBIGINT|UINTEGER)/.test(type)) return "number";
  return "text";
}

type OpInfo = { value: FilterOp; label: string; dateLabel?: string; needs: ValueKind; kinds: ColumnKind[] };

const OPS: OpInfo[] = [
  { value: "eq", label: "is", needs: "one", kinds: ["text", "number", "date", "boolean"] },
  { value: "neq", label: "is not", needs: "one", kinds: ["text", "number", "date", "boolean"] },
  { value: "in", label: "is one of", needs: "list", kinds: ["text", "number"] },
  { value: "not_in", label: "is not one of", needs: "list", kinds: ["text", "number"] },
  { value: "contains", label: "contains", needs: "one", kinds: ["text"] },
  { value: "gt", label: "more than", dateLabel: "after", needs: "one", kinds: ["number", "date"] },
  { value: "gte", label: "at least", dateLabel: "on or after", needs: "one", kinds: ["number", "date"] },
  { value: "lt", label: "less than", dateLabel: "before", needs: "one", kinds: ["number", "date"] },
  { value: "lte", label: "at most", dateLabel: "on or before", needs: "one", kinds: ["number", "date"] },
  { value: "between", label: "between", needs: "two", kinds: ["number", "date"] },
  { value: "last_days", label: "in the last … days", needs: "count", kinds: ["date"] },
  { value: "last_months", label: "in the last … months", needs: "count", kinds: ["date"] },
  { value: "this_financial_year", label: "in this financial year", needs: "none", kinds: ["date"] },
  { value: "last_financial_year", label: "in last financial year", needs: "none", kinds: ["date"] },
  { value: "blank", label: "is blank", needs: "none", kinds: ["text", "number", "date", "boolean"] },
  { value: "not_blank", label: "is not blank", needs: "none", kinds: ["text", "number", "date", "boolean"] },
];

export const FILTER_OPS: readonly FilterOp[] = OPS.map((op) => op.value);

/** The tests offered for a column of this type, in the order they're listed. */
export function opsFor(type: string): Array<{ value: FilterOp; label: string }> {
  const kind = columnKind(type);
  return OPS.filter((op) => op.kinds.includes(kind)).map((op) => ({ value: op.value, label: (kind === "date" && op.dateLabel) || op.label }));
}

export function opAllowed(op: FilterOp, type: string): boolean {
  return OPS.some((entry) => entry.value === op && entry.kinds.includes(columnKind(type)));
}

/** What a test needs: nothing, one value, a list, two values (between) or a number of days or months. */
export function valueKind(op: FilterOp): ValueKind {
  return OPS.find((entry) => entry.value === op)?.needs ?? "one";
}

/** The most months and days "in the last …" goes back. */
export const MAX_LAST_MONTHS = 120;
export const MAX_LAST_DAYS = 3660;

/** Whether a filter has everything it needs; ones that don't are dropped when the tile is saved. */
export function filterComplete(filter: Filter): boolean {
  const value = filter.value;
  switch (valueKind(filter.op)) {
    case "none":
      return true;
    case "list":
      return Array.isArray(value) && value.length > 0;
    case "two":
      return Array.isArray(value) && value.length === 2 && value.every((entry) => String(entry).trim() !== "");
    case "count":
      return /^\d+$/.test(String(value).trim()) && Number(value) >= 1;
    default:
      return !Array.isArray(value) && String(value).trim() !== "";
  }
}

/** A filter after its column or test changes: the value is kept only if it still fits. */
export function changeFilter(filter: Filter, patch: Partial<Filter>, columns: ColumnInfo[]): Filter {
  const next: Filter = { ...filter, ...patch };
  const type = columns.find((column) => column.name === next.field)?.type ?? "VARCHAR";
  if (!opAllowed(next.op, type)) next.op = "eq";
  const fieldChanged = patch.field !== undefined && patch.field !== filter.field;
  const before = valueKind(filter.op);
  const after = valueKind(next.op);
  if ("value" in patch && !fieldChanged) return next;
  if (fieldChanged || before !== after) next.value = after === "list" ? [] : after === "two" ? ["", ""] : "";
  return next;
}
