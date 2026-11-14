/**
 * What a person (or an AI) is told when the database refuses something
 * (#698, decision 1636). PostgreSQL's own message names tables, columns and
 * constraints ("violates check constraint invoices_total_check"), which is
 * the database's inside and no use to the reader, so it goes to the server
 * log and a plain sentence goes out. The exception is a rule Tohyee wrote
 * itself (raise exception in a trigger, P0001): those messages are written
 * for people and say which rule, so they pass through.
 */
const PLAIN: Record<string, string> = {
  "23505": "That's already there: it would be a duplicate.",
  "23503": "That refers to something that isn't there, or it's still used by something else.",
  "23514": "That isn't allowed: a value is outside what the record can hold.",
  "23502": "Something required was left out.",
  "22P02": "One of the values isn't in the form it should be.",
  "22007": "One of the dates isn't a date.",
  "22008": "One of the dates is out of range.",
};

/** The codes that mean "the request broke a rule", with the HTTP status each gets. */
export const CLIENT_PG_ERRORS: Record<string, number> = {
  "23505": 409, // unique_violation
  "23503": 400, // foreign_key_violation
  "23514": 400, // check_violation (includes unbalanced journals)
  "23502": 400, // not_null_violation
  "22P02": 400, // invalid_text_representation
  "22007": 400, // invalid_datetime_format
  "22008": 400, // datetime_field_overflow
  P0001: 400, // raise_exception (append-only guard)
};

/** The PostgreSQL error code on a thrown error, if it has one. */
export function pgErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * The sentence to send for a database refusal, logging the original. Null
 * when the error isn't one of the refusals people can cause (the caller
 * treats it as an unexpected server error).
 */
export function plainDatabaseError(error: unknown, where: string): string | null {
  const code = pgErrorCode(error);
  if (!code || !(error instanceof Error)) return null;
  if (code === "P0001") return error.message;
  // Any other refusal of the data itself (classes 22 and 23) gets a general sentence; everything else is the server's problem.
  const plain = PLAIN[code] ?? (/^(22|23)/.test(code) ? "That isn't allowed: a value doesn't fit what the record can hold." : null);
  if (!plain) return null;
  console.warn(`[tohyee] the database refused a request (${where}, ${code}): ${error.message}`);
  return plain;
}
