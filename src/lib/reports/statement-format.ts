/** How statement amounts print (FS3): pure, so the screen and the PDF share it. */

/** Shows an amount as in printed statements: 1,234.56, negatives in brackets, "-" for nothing. */
export function statementAmount(value: string | null): string {
  if (value === null) return "";
  const negative = value.startsWith("-");
  const [whole, cents = "00"] = (negative ? value.slice(1) : value).split(".");
  if (/^0+$/.test(whole) && /^0*$/.test(cents)) return "-";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `(${grouped}.${cents})` : `${grouped}.${cents}`;
}

/** A line's amount as printed: money as in statements (FS3), a % or plain number from a layout. */
export function statementValue(line: { format?: "money" | "percent" | "number" }, value: string | null): string {
  if (line.format === "percent") return value === null ? "" : `${value}%`;
  if (line.format === "number") return value ?? "";
  return statementAmount(value ?? "0");
}
