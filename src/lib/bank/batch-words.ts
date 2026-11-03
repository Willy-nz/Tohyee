/**
 * Words for bank batches on screen (#547). Browser-safe: no server imports.
 */

export type BatchCountsLike = { total: number; committed: number; failed: number; pending: number; inProgress: number; unknown: number };

export const BATCH_KIND_LABELS: Record<string, string> = {
  bank_reconcile: "Reconciled by AI",
  bank_unreconcile: "Unreconciled",
  bank_undo: "Undo of a batch",
};

export const BATCH_STATE_LABELS: Record<string, string> = {
  done: "Done",
  finished_with_failures: "Finished, some refused",
  working: "Working on it",
  waiting: "Not finished",
  rate_limited: "Waiting to carry on",
};

export const ACTION_LABELS: Record<string, string> = {
  match: "Match",
  create_and_match: "Spend or receive money",
  transfer_and_match: "Transfer",
  apply_bank_rule: "Bank rule",
  unreconcile: "Unreconcile",
  undo: "Undo",
};

export const ACTION_STATUS_LABELS: Record<string, string> = {
  committed: "Done",
  failed: "Refused",
  pending: "Not started",
  in_progress: "Working on it",
  unknown: "Outcome unknown",
};

/** "3 done, 1 refused, 2 not started" (only the parts that aren't zero). */
export function countsText(counts: BatchCountsLike): string {
  const parts: string[] = [];
  if (counts.committed) parts.push(`${counts.committed} done`);
  if (counts.failed) parts.push(`${counts.failed} refused`);
  if (counts.pending) parts.push(`${counts.pending} not started`);
  if (counts.inProgress) parts.push(`${counts.inProgress} being done`);
  if (counts.unknown) parts.push(`${counts.unknown} outcome unknown`);
  return parts.length ? parts.join(", ") : "Nothing in it";
}

/** Whether "Resume" has anything to do: something not started or with an unknown outcome. */
export function canResume(counts: BatchCountsLike, state: string): boolean {
  return state !== "working" && counts.pending + counts.unknown > 0;
}

/** The confirm button's words for a plan: "Unreconcile 3 lines" / "Undo 2 lines and void 1". */
export function planButtonText(mode: "unreconcile" | "undo", counts: { lines: number; voids: number }): string {
  const lines = `${counts.lines} line${counts.lines === 1 ? "" : "s"}`;
  if (mode === "unreconcile") return `Unreconcile ${lines}`;
  return counts.voids ? `Unreconcile ${lines} and void ${counts.voids}` : `Unreconcile ${lines}`;
}

/** Selection on a page of lines: toggles one id; `all` toggles every selectable id on the page. */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function toggleAll(selected: ReadonlySet<string>, pageIds: readonly string[]): Set<string> {
  const allChosen = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of pageIds) {
    if (allChosen) next.delete(id);
    else next.add(id);
  }
  return next;
}
