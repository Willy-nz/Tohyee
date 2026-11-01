import { writeAuditEvent } from "@/lib/audit";
import { isRole } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { accessFor, GRANTABLE_ROLES, SECURITY_LEVELS, type SecurityAccess, type SecurityLevel } from "@/lib/security-cameras/shared";

/*
 * Who may do what with farm security cameras (#508, decision 1220).
 * Checked here, in the services every route and media URL goes through:
 *
 * - Owners and admins: see, download, delete and set up.
 * - Anyone else: nothing, unless an owner or admin gives them "see",
 *   "see and download" or "see, download and delete" on People and roles.
 *   Farm staff, viewers and bookkeepers can be given it; sales and
 *   report-only roles can't.
 * - Always only on the farms the person works on (decision 744).
 * - Work Tohyee does itself (uploads, clean-up) has no person and no limits.
 */

const levels = new WeakMap<object, Promise<SecurityAccess>>();

async function load(tx: OrgTx): Promise<SecurityAccess> {
  if (!tx.actor.userId) return { view: true, download: true, delete: true, configure: true };
  const row = await tx.query<{ level: SecurityLevel }>("select level from security_camera_access where user_id = $1", [tx.actor.userId]);
  const role = tx.actor.role;
  const level = role && (GRANTABLE_ROLES as readonly string[]).includes(role) ? (row.rows[0]?.level ?? null) : null;
  return accessFor(role, level);
}

export function securityAccess(tx: OrgTx): Promise<SecurityAccess> {
  let access = levels.get(tx);
  if (!access) {
    access = load(tx);
    levels.set(tx, access);
  }
  return access;
}

const REFUSED: Record<keyof SecurityAccess, string> = {
  view: "Security cameras are only for people an owner or admin has given camera access, on People and roles.",
  download: "Downloading camera media needs download access. An owner or admin can give it on People and roles.",
  delete: "Deleting camera media needs delete access. An owner or admin can give it on People and roles.",
  configure: "Setting up cameras is for owners and admins.",
};

/** Farming must be on and the person must have this right. */
export async function requireSecurity(tx: OrgTx, need: keyof SecurityAccess): Promise<SecurityAccess> {
  await requireFarming(tx);
  const access = await securityAccess(tx);
  if (!access[need]) throw new ForbiddenError(REFUSED[need]);
  return access;
}

/** A farm the person can't see is "not found", as everywhere on the farm. */
export async function requireSecurityFarm(tx: OrgTx, farmId: string): Promise<void> {
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
}

// Grants ------------------------------------------------------------------------------------

export type MemberCameraAccess = { userId: string; level: SecurityLevel; grantedByEmail: string; grantedAt: string };

export async function listCameraAccess(tx: OrgTx): Promise<MemberCameraAccess[]> {
  await requireSecurity(tx, "configure");
  const rows = await tx.query<{ user_id: string; level: SecurityLevel; granted_by_email: string; granted_at: Date }>("select user_id::text, level, granted_by_email, granted_at from security_camera_access order by granted_at");
  return rows.rows.map((row) => ({ userId: row.user_id, level: row.level, grantedByEmail: row.granted_by_email, grantedAt: new Date(row.granted_at).toISOString() }));
}

/**
 * Gives a member camera access at a level, or takes it away (`level`
 * null). `role` is their role from the core database (the route looks it
 * up; it's never taken from the request). Audited.
 */
export async function setCameraAccess(tx: OrgTx, input: { userId: unknown; role: unknown; level: unknown }): Promise<MemberCameraAccess[]> {
  await requireSecurity(tx, "configure");
  const userId = typeof input.userId === "string" && /^[0-9a-f-]{36}$/i.test(input.userId) ? input.userId.toLowerCase() : null;
  if (!userId) throw new ValidationError("Choose a member.");
  if (!isRole(input.role)) throw new ValidationError("That member's role isn't known.");
  const level = input.level === null || input.level === "" || input.level === "none" ? null : input.level;
  if (level !== null && !(SECURITY_LEVELS as readonly unknown[]).includes(level)) throw new ValidationError("Choose see, download or delete.");
  if (input.role === "owner" || input.role === "admin") throw new ValidationError("Owners and admins already have every camera right.");
  if (level !== null && !(GRANTABLE_ROLES as readonly string[]).includes(input.role)) throw new ValidationError("Camera access is for farm staff, viewers and bookkeepers.");
  if (level === null) {
    await tx.query("delete from security_camera_access where user_id = $1", [userId]);
  } else {
    await tx.query(
      `insert into security_camera_access (user_id, level, granted_by_email) values ($1, $2, $3)
       on conflict (user_id) do update set level = excluded.level, granted_by_email = excluded.granted_by_email, granted_at = now()`,
      [userId, level, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, { eventType: level === null ? "security.access_removed" : "security.access_set", entityType: "user", entityId: userId, details: { level } });
  return listCameraAccess(tx);
}

