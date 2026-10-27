import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Launch tiles for the farm apps an organisation uses (#447, decision 908):
 * a name and an address, shown on Today and More for everyone who works on
 * that farm. Tiles hold no keys or secrets; an app's key belongs to the
 * person who made it (Farm apps › Manage integrations). Admins add and
 * remove tiles.
 */

export type FarmAppLauncher = { id: string; name: string; url: string; description: string | null; farmId: string | null; createdByEmail: string };

const MAX_LAUNCHERS = 24;

/** An address an app opens at: https, or http only on this computer (an app being built). No user names or passwords in it. */
export function launcherUrl(input: unknown): string {
  const text = requireString(input, "Address", { maxLength: 500 });
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ValidationError("The address must be a full web address, like https://app.example.nz.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new ValidationError("The address must start with https:// (http:// only for localhost).");
  if (url.username || url.password) throw new ValidationError("Leave user names and passwords out of the address: the app asks for its key itself.");
  if (/tohyee_app_|tohyee_ai_/i.test(text)) throw new ValidationError("Leave keys out of the address: a tile is seen by everyone on the farm.");
  return url.toString();
}

export async function listLaunchers(tx: OrgTx): Promise<FarmAppLauncher[]> {
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  const rows = await tx.query<{ id: string; name: string; url: string; description: string | null; farm_id: string | null; created_by_email: string }>(
    `select l.id::text, l.name, l.url, l.description, l.farm_id::text, l.created_by_email from farm_app_launchers l
      where l.removed_at is null and (l.farm_id is null or $1::bigint[] is null or l.farm_id = any($1::bigint[]))
      order by lower(l.name), l.id`,
    [visible],
  );
  return rows.rows.map((row) => ({ id: row.id, name: row.name, url: row.url, description: row.description, farmId: row.farm_id, createdByEmail: row.created_by_email }));
}

export async function addLauncher(tx: OrgTx, input: { name: unknown; url: unknown; description?: unknown; farmId?: unknown }): Promise<FarmAppLauncher[]> {
  await requireFarming(tx);
  const name = requireString(input.name, "Name", { maxLength: 60 });
  const url = launcherUrl(input.url);
  const description = optionalString(input.description, "Description", { maxLength: 200 });
  let farmId: string | null = null;
  if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "") {
    farmId = requireId(input.farmId, "farmId");
    const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
    if (!farm.rowCount) throw new NotFoundError("Farm not found.");
    await requireFarmAccess(tx, farmId);
  }
  const count = await tx.query<{ n: number }>("select count(*)::int as n from farm_app_launchers where removed_at is null");
  if (count.rows[0].n >= MAX_LAUNCHERS) throw new ValidationError(`There can be up to ${MAX_LAUNCHERS} app tiles. Remove one first.`);
  const row = await tx.query<{ id: string }>("insert into farm_app_launchers (name, url, description, farm_id, created_by_email) values ($1, $2, $3, $4, $5) returning id::text", [name, url, description, farmId, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.app_launcher_added", entityType: "farm_app_launcher", entityId: row.rows[0].id, details: { name, url, farmId } });
  return listLaunchers(tx);
}

export async function removeLauncher(tx: OrgTx, idInput: unknown): Promise<FarmAppLauncher[]> {
  await requireFarming(tx);
  const id = requireId(idInput, "launcherId");
  const removed = await tx.query("update farm_app_launchers set removed_at = now(), removed_by_email = $2 where id = $1 and removed_at is null returning id", [id, tx.actor.email]);
  if (!removed.rowCount) throw new NotFoundError("App tile not found, or already removed.");
  await writeAuditEvent(tx, { eventType: "farming.app_launcher_removed", entityType: "farm_app_launcher", entityId: id, details: {} });
  return listLaunchers(tx);
}
