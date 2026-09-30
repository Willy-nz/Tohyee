import type { StatementLine } from "@/lib/bank/accounts";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { HttpError, ValidationError } from "@/lib/errors";
import { requireArray, requireId } from "@/lib/validation";

/**
 * Bulk actions on statement lines ("OK all confident matches", cash coding):
 * each line is done in its own transaction, so a line that's refused (a
 * locked period, a changed suggestion) doesn't stop the others. The result
 * says, line by line, what happened and why.
 */
export type LineOutcome =
  | { lineId: string; ok: true; created: boolean; line: StatementLine }
  | { lineId: string; ok: false; error: string };

export type BulkResult = { results: LineOutcome[]; succeeded: number; failed: number };

/** Postgres errors that mean the request broke a rule (their message is for people), as in the API's error handling. */
const RULE_ERRORS = new Set(["23505", "23503", "23514", "23502", "P0001"]);

/** A message to show for a line that failed. Unexpected errors are logged, not shown. */
export function lineErrorText(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && RULE_ERRORS.has(code) && error instanceof Error) return error.message;
  console.error("[tohyee] unexpected error in a bulk bank action:", error);
  return "Something went wrong on the server with this line. Check the server logs.";
}

/** Each line's key is the request's key plus the line id (and more inside), so the request's own key is kept short. */
export function assertBulkKey(idempotencyKey: string): void {
  if (idempotencyKey.length > 80) throw new ValidationError("idempotencyKey must be at most 80 characters for a bulk action.");
}

/** The distinct line ids of a bulk request (at most `max`). */
export function parseLineIds(input: unknown, max = 200): string[] {
  const ids = [...new Set(requireArray(input, "lineIds", max).map((id, index) => requireId(id, `lineIds[${index}]`)))];
  if (ids.length === 0) throw new ValidationError("Choose at least one statement line.");
  return ids;
}

/** Runs `work` for each line in its own transaction, in order, collecting what happened. */
export async function eachLine<T extends { lineId: string }>(
  run: OrgRunner,
  items: readonly T[],
  work: (tx: OrgTx, item: T) => Promise<{ created: boolean; line: StatementLine }>,
): Promise<BulkResult> {
  const results: LineOutcome[] = [];
  for (const item of items) {
    try {
      const done = await run((tx) => work(tx, item));
      results.push({ lineId: item.lineId, ok: true, created: done.created, line: done.line });
    } catch (error) {
      results.push({ lineId: item.lineId, ok: false, error: lineErrorText(error) });
    }
  }
  const succeeded = results.filter((result) => result.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}
