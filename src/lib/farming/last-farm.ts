import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { canSeeFarm, requireFarmAccess } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { requireId } from "@/lib/validation";

/*
 * The farm each person last worked on (#447, decision 900), so farm pages
 * open on it on any device instead of empty. A convenience only: it's
 * offered only while the farm is active and the person can still see it
 * (decision 744), so a farm taken off someone is never opened for them.
 */

/** The person's last farm, if it's still active and theirs to see; otherwise null. */
export async function lastFarm(tx: OrgTx): Promise<string | null> {
  await requireFarming(tx);
  const userId = tx.actor.userId;
  if (!userId) return null;
  const row = await tx.query<{ farm_id: string }>(
    "select l.farm_id::text from farm_last_used l join farms f on f.id = l.farm_id where l.user_id = $1 and f.is_active",
    [userId],
  );
  const farmId = row.rows[0]?.farm_id ?? null;
  if (farmId === null || !(await canSeeFarm(tx, farmId))) return null;
  return farmId;
}

/** Remembers the farm the person chose. Only an active farm they can see. */
export async function rememberFarm(tx: OrgTx, farmIdInput: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(farmIdInput, "farmId");
  await requireFarmAccess(tx, farmId);
  const farm = await tx.query<{ is_active: boolean }>("select is_active from farms where id = $1", [farmId]);
  if (!farm.rows[0]) throw new ValidationError("Farm not found.");
  if (!farm.rows[0].is_active) throw new ValidationError("That farm is archived.");
  const userId = tx.actor.userId;
  if (!userId) return farmId;
  await tx.query(
    "insert into farm_last_used (user_id, farm_id) values ($1, $2) on conflict (user_id) do update set farm_id = excluded.farm_id, chosen_at = now()",
    [userId, farmId],
  );
  return farmId;
}
