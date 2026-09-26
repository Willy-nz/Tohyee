const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** Quotes a trusted, validated identifier such as a database name. */
export function quoteSqlIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error("Invalid SQL identifier.");
  }

  return `"${value}"`;
}
