import type { CrmScope } from "@/lib/crm/access";
import { ForbiddenError, ValidationError } from "@/lib/errors";

/**
 * The rules of bulk reassignment (decision 650) that need no database, so the
 * page can use them too. See `reassign.ts`.
 */
export const REASSIGN_KINDS = ["leads", "companies", "opportunities", "tasks", "sequences"] as const;
export type ReassignKind = (typeof REASSIGN_KINDS)[number];
/** At most this many of each kind in one move; the preview says when there are more. */
export const REASSIGN_LIMIT = 2000;

export type ReassignItem = { id: string; name: string; detail: string | null };
export type ReassignPreview = {
  fromUserId: string | null;
  toUserId: string;
  includeClosedDeals: boolean;
  records: Record<ReassignKind, ReassignItem[]>;
  /** Kinds with more than REASSIGN_LIMIT to move: only the first REASSIGN_LIMIT are listed and moved. */
  more: ReassignKind[];
};
export type ReassignResult = { batchId: string; moved: Record<ReassignKind, number>; skipped: number };
export type ReassignmentEntry = {
  batchId: string;
  at: string;
  byEmail: string | null;
  byUserId: string | null;
  fromUserId: string | null;
  toUserId: string;
  moved: Record<ReassignKind, number>;
};

/** Which kinds can move from nobody: companies without an owner are most of the books' contacts, so they're left out. */
export function kindsFor(from: string | null, kinds: readonly ReassignKind[], scope: Pick<CrmScope, "owners" | "role">): ReassignKind[] {
  return kinds.filter((kind) => {
    if (from !== null) return true;
    if (kind === "companies" || kind === "sequences") return false;
    // A manager sees unassigned leads, but not unassigned deals or tasks (decision 491).
    if (scope.owners !== null) return kind === "leads";
    return true;
  });
}

/** Whether this person may move records from `from` to `to` (decision 650). Throws with the reason if not. */
export function checkReassignAllowed(scope: Pick<CrmScope, "owners" | "role" | "canWrite">, from: string | null, to: string): void {
  if (!scope.canWrite) throw new ForbiddenError("Moving records needs the bookkeeper role or higher, or the sales manager role.");
  if (scope.role === "sales_rep") throw new ForbiddenError("A sales rep can't move records to someone else. Ask your sales manager.");
  if (from !== null && from === to) throw new ValidationError("Choose a different person to move them to.");
  if (scope.owners === null) return;
  const inTeams = (id: string) => scope.owners!.includes(id);
  if ((from !== null && !inTeams(from)) || !inTeams(to)) {
    throw new ForbiddenError("A sales manager can only move records between themselves and the people in their teams.");
  }
}

/** The ids still ticked in a preview: everything listed less what was unticked. */
export function tickedIds(preview: ReassignPreview, unticked: ReadonlySet<string>): Record<ReassignKind, string[]> {
  const ids = {} as Record<ReassignKind, string[]>;
  for (const kind of REASSIGN_KINDS) ids[kind] = preview.records[kind].map((item) => item.id).filter((id) => !unticked.has(`${kind}:${id}`));
  return ids;
}
