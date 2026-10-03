/**
 * Exact decimal arithmetic in DuckDB SQL. DuckDB divides decimals (and works
 * out avg) in DOUBLE, which loses cents on large amounts, so division is done
 * on whole numbers of millionths instead: both sides are scaled to HUGEINT,
 * divided with rounding half away from zero, and scaled back to
 * DECIMAL(38,6). A zero divisor gives null. Too large a value raises an
 * overflow error rather than a wrong answer.
 */
export const DECIMAL_RESULT = "DECIMAL(38,6)";

const MILLIONTHS = "1000000";

function millionths(sql: string): string {
  return `cast(cast(${sql} as ${DECIMAL_RESULT}) * ${MILLIONTHS} as HUGEINT)`;
}

/** `numerator / denominator` as DECIMAL(38,6), exactly. */
export function exactDivideSql(numerator: string, denominator: string): string {
  const a = millionths(numerator);
  const d = millionths(denominator);
  return `(case when ${d} = 0 then null else cast(sign(${a}) * sign(${d}) * ((abs(${a}) * ${2 * 1_000_000} + abs(${d})) // (2 * abs(${d}))) as DECIMAL(38,0)) * 0.000001 end)`;
}

/** The average of a number column as DECIMAL(38,6), without going through DOUBLE. */
export function exactAverageSql(column: string): string {
  return exactDivideSql(`sum(${column})`, `count(${column})`);
}

/** Rounds any decimal expression (e.g. a product with a long scale) to DECIMAL(38,6). */
export function decimalResultSql(sql: string): string {
  return `cast(${sql} as ${DECIMAL_RESULT})`;
}
