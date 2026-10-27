import { writeAuditEvent } from "@/lib/audit";
import { isRole, type Role } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

/*
 * Which farms a member may see and record for (#390, FA-series examples
 * FMA1-FMA8, decision 744; Jess, 21 October 2026: "Yes, assigned farms
 * only"). Enforced here, in the services every route, farm app, AI tool and
 * Home card goes through; the farm selector on screens is only a convenience.
 *
 * - Owners and admins see every farm.
 * - With fewer than two farms (archived ones count) there's nothing to keep
 *   apart, and everyone sees the farm.
 * - Otherwise viewers and bookkeepers see "all farms" if given that, else only
 *   the farms they're assigned to, and none until they're assigned.
 * - Work Tohyee does by itself (no person) sees every farm.
 * - A person whose role isn't known here is treated like a viewer: assigned
 *   farms only.
 */

export const ALL_FARM_ROLES: readonly Role[] = ["owner", "admin"];

export type FarmScope = { all: true } | { all: false; farmIds: ReadonlySet<string> };

const scopes = new WeakMap<object, Promise<FarmScope>>();

async function loadScope(tx: OrgTx): Promise<FarmScope> {
  const { userId, role } = tx.actor;
  if (!userId) return { all: true };
  if (role && ALL_FARM_ROLES.includes(role)) return { all: true };
  const farms = await tx.query<{ n: number }>("select count(*)::int as n from farms");
  if (farms.rows[0].n < 2) return { all: true };
  const scope = await tx.query<{ all_farms: boolean }>("select all_farms from farm_member_scopes where user_id = $1", [userId]);
  if (scope.rows[0]?.all_farms) return { all: true };
  const assigned = await tx.query<{ farm_id: string }>("select farm_id::text from farm_member_farms where user_id = $1", [userId]);
  return { all: false, farmIds: new Set(assigned.rows.map((row) => row.farm_id)) };
}

/** The acting person's farms, worked out once per transaction. */
export function farmScope(tx: OrgTx): Promise<FarmScope> {
  let scope = scopes.get(tx);
  if (!scope) {
    scope = loadScope(tx);
    scopes.set(tx, scope);
  }
  return scope;
}

export async function canSeeFarm(tx: OrgTx, farmId: string): Promise<boolean> {
  const scope = await farmScope(tx);
  return scope.all || scope.farmIds.has(farmId);
}

/** Null when every farm is visible, else the visible farms' ids (perhaps none), for `farm_id = any($n::bigint[])`. */
export async function visibleFarmIds(tx: OrgTx): Promise<string[] | null> {
  const scope = await farmScope(tx);
  return scope.all ? null : [...scope.farmIds];
}

/** A farm the person can't see is "not found", so its existence isn't given away. */
export async function requireFarmAccess(tx: OrgTx, farmId: string, notFound = "Farm not found."): Promise<void> {
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError(notFound);
}

/** The paddock's farm must be one the person can see. */
export async function requirePaddockAccess(tx: OrgTx, paddockId: string): Promise<void> {
  const row = await tx.query<{ farm_id: string }>("select farm_id::text from paddocks where id = $1", [paddockId]);
  if (!row.rows[0] || !(await canSeeFarm(tx, row.rows[0].farm_id))) throw new NotFoundError("Paddock not found.");
}

const FARM_TABLES = ["pasture_readings", "grazings", "supplements_fed", "soil_tests", "soil_samples", "fertiliser_plans"] as const;

/** A record on a farm-scoped table (by id) must be on a farm the person can see; otherwise it's "not found". */
export async function requireRecordAccess(tx: OrgTx, table: (typeof FARM_TABLES)[number], id: string, notFound: string): Promise<void> {
  if (!FARM_TABLES.includes(table)) throw new Error(`Not a farm table: ${table}`);
  const row = await tx.query<{ farm_id: string }>(`select farm_id::text from ${table} where id = $1`, [id]);
  if (row.rows[0] && !(await canSeeFarm(tx, row.rows[0].farm_id))) throw new NotFoundError(notFound);
}

/** For what spans every farm (adding a farm, the farm notebook, Analytics' farm tables). */
export async function requireAllFarms(tx: OrgTx, what: string): Promise<void> {
  if (!(await farmScope(tx)).all) throw new ForbiddenError(`${what} is only for members who see every farm. An owner or admin can change which farms you see.`);
}

// Assignments ---------------------------------------------------------------------------------

export type MemberFarmAccess = {
  userId: string;
  /** "all": every farm; "farms": only `farmIds`; "unassigned": no choice made yet (no farms while there are two or more). */
  access: "all" | "farms" | "unassigned";
  farmIds: string[];
};

export async function listMemberFarmAccess(tx: OrgTx): Promise<MemberFarmAccess[]> {
  const scopes = await tx.query<{ user_id: string; all_farms: boolean }>("select user_id::text, all_farms from farm_member_scopes order by user_id");
  const farms = await tx.query<{ user_id: string; farm_id: string }>("select user_id::text, farm_id::text from farm_member_farms order by user_id, farm_id");
  return scopes.rows.map((row) => ({
    userId: row.user_id,
    access: row.all_farms ? "all" : "farms",
    farmIds: farms.rows.filter((farm) => farm.user_id === row.user_id).map((farm) => farm.farm_id),
  }));
}

/**
 * Sets which farms a member works on (FMA2). `role` is the member's role,
 * from the core database: owners and admins always see every farm, so
 * nothing is stored for them. Only owners and admins may call this (the
 * route checks).
 */
export async function setMemberFarmAccess(
  tx: OrgTx,
  input: { userId: unknown; role: unknown; access: unknown; farmIds?: unknown },
): Promise<MemberFarmAccess[]> {
  const userId = typeof input.userId === "string" && /^[0-9a-f-]{36}$/i.test(input.userId) ? input.userId.toLowerCase() : null;
  if (!userId) throw new ValidationError("Choose a member.");
  if (!isRole(input.role)) throw new ValidationError("That member's role isn't known.");
  if (ALL_FARM_ROLES.includes(input.role)) throw new ValidationError("Owners and admins see every farm.");
  if (input.access !== "all" && input.access !== "farms" && input.access !== "unassigned") throw new ValidationError("Choose all farms, some farms or not yet.");
  await tx.query("delete from farm_member_scopes where user_id = $1", [userId]);
  let farmIds: string[] = [];
  if (input.access !== "unassigned") {
    await tx.query("insert into farm_member_scopes (user_id, all_farms, updated_by_email) values ($1, $2, $3)", [userId, input.access === "all", tx.actor.email]);
  }
  if (input.access === "farms") {
    farmIds = Array.isArray(input.farmIds) ? [...new Set(input.farmIds.map(String))] : [];
    const found = await tx.query<{ id: string }>("select id::text from farms where id = any($1::bigint[])", [farmIds.filter((id) => /^[1-9]\d{0,17}$/.test(id))]);
    if (found.rows.length !== farmIds.length) throw new ValidationError("One of those farms wasn't found.");
    for (const farmId of farmIds) await tx.query("insert into farm_member_farms (user_id, farm_id) values ($1, $2)", [userId, farmId]);
  }
  // A remembered farm they can no longer see is forgotten (decision 900); it's also checked on every read.
  if (input.access !== "all") await tx.query("delete from farm_last_used where user_id = $1 and not (farm_id = any($2::bigint[]))", [userId, farmIds]);
  await writeAuditEvent(tx, { eventType: "farming.member_farms_set", entityType: "user", entityId: userId, details: { access: input.access, farmIds } });
  return listMemberFarmAccess(tx);
}

/** When someone leaves the organisation, their farm assignments go too. */
export async function forgetMemberFarmAccess(tx: OrgTx, userId: string): Promise<void> {
  await tx.query("delete from farm_member_scopes where user_id = $1", [userId]);
  await tx.query("delete from farm_last_used where user_id = $1", [userId]);
}
