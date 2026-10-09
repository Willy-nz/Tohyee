import { crmAllows, type Role, isSalesRole } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

/**
 * Who sees what in the CRM (decision 491, #216).
 *
 *  - viewer and up: every CRM record, as before; bookkeepers and up change
 *    records, admins set the CRM up.
 *  - sales_rep: every company and person (one shared address book), but only
 *    the deals and tasks they own or are assigned, and their own forecast.
 *  - sales_manager: as a rep, plus those of the reps in the teams they manage.
 *  - report_viewer: nothing of the CRM.
 *
 * Sales roles never see the books: no invoice figures or accounting history
 * on a company or deal, and no making invoices or sales orders.
 */
export type CrmScope = {
  role: Role;
  userId: string;
  /** A CRM-only role (sales rep or manager). */
  sales: boolean;
  /** The owners and assignees whose deals and tasks this person sees; null means everyone's. */
  owners: string[] | null;
  canWrite: boolean;
  canAdmin: boolean;
};

export type CrmNeed = "read" | "write" | "admin";

export { crmAllows };

/** The people a sales manager manages: themselves and every member of their teams. */
async function managedOwners(tx: OrgTx, userId: string): Promise<string[]> {
  const result = await tx.query<{ user_id: string }>(
    `select m.user_id from crm_team_members m join crm_teams t on t.id = m.team_id where t.manager_user_id = $1
     order by m.user_id`,
    [userId],
  );
  return [userId, ...result.rows.map((row) => row.user_id).filter((id) => id !== userId)];
}

export async function crmScope(tx: OrgTx, role: Role, userId: string): Promise<CrmScope> {
  const sales = isSalesRole(role);
  const owners = role === "sales_rep" ? [userId] : role === "sales_manager" ? await managedOwners(tx, userId) : null;
  return { role, userId, sales, owners, canWrite: crmAllows(role, "write"), canAdmin: crmAllows(role, "admin") };
}

/** A scope that sees everything, for code that isn't answering one person (schedulers, tests). */
export function fullCrmScope(userId = ""): CrmScope {
  return { role: "owner", userId, sales: false, owners: null, canWrite: true, canAdmin: true };
}

export function seesOwner(scope: CrmScope | undefined, ownerUserId: string | null): boolean {
  if (!scope || scope.owners === null) return true;
  return ownerUserId !== null && scope.owners.includes(ownerUserId);
}

/**
 * Whether the scope sees a lead (decision 492): its owner's, as a deal; one
 * nobody owns yet (from a web form or email, waiting to be picked up) is seen
 * by sales managers, and by viewers and up, but not by reps.
 */
export function seesLead(scope: CrmScope | undefined, ownerUserId: string | null): boolean {
  if (!scope || scope.owners === null) return true;
  if (ownerUserId === null) return scope.role === "sales_manager";
  return scope.owners.includes(ownerUserId);
}

/** Refuses a record outside the person's scope as "not found", so ids can't be probed. */
export function assertSeesOwner(scope: CrmScope | undefined, ownerUserId: string | null, what: string): void {
  if (!seesOwner(scope, ownerUserId)) throw new NotFoundError(`${what} not found.`);
}

/**
 * The owner or assignee a scoped person may give a deal or task: themselves
 * when none is given, and only someone they can see (a rep: only themselves;
 * a manager: their teams), so nothing they make drops out of their sight.
 */
export function ownerFor(scope: CrmScope | undefined, wanted: string | null, current: string | null): string | null {
  if (!scope || scope.owners === null) return wanted;
  const owner = wanted ?? current ?? scope.userId;
  if (!scope.owners.includes(owner)) {
    throw new ForbiddenError(
      scope.role === "sales_rep"
        ? "A sales rep can only own their own deals and tasks."
        : "A sales manager can only give deals and tasks to themselves or the reps in their teams.",
    );
  }
  return owner;
}

/** SQL for "the owner column is one this person sees": `true` when they see everyone. Adds the owners as a parameter. */
export function ownerFilter(scope: CrmScope | undefined, column: string, params: unknown[]): string {
  if (!scope || scope.owners === null) return "true";
  params.push(scope.owners);
  return `${column} = any($${params.length}::text[])`;
}
