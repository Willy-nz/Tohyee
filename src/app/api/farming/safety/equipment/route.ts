import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addEquipment, listEquipment } from "@/lib/safety/equipment";
import { safetyPeople, safetyPeopleMap } from "@/lib/safety/people";
import { canRecordSafety } from "@/lib/safety/records";

/** GET: a farm's equipment (in use or out of use), its checklists, and for recorders the people and fixed assets to link. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const canRecord = canRecordSafety(tx);
    const assets = canRecord ? await tx.query<{ id: string; name: string; asset_number: string }>("select id::text, name, asset_number from fixed_assets where status <> 'archived' order by fixed_assets.asset_number") : { rows: [] };
    return {
      ...(await listEquipment(tx, params.get("farmId"))),
      canRecord,
      people: canRecord ? await safetyPeople(tx.organisationId) : [],
      fixedAssets: assets.rows.map((row) => ({ id: row.id, name: `${row.asset_number} ${row.name}` })),
    };
  });
  return json(result);
});

/** Adds equipment to a farm (`name`, `type`, `owner`, optional `fixedAssetId`, `checklistId`, `responsibleUserId`, `releaserUserIds`). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const equipment = await withOrganisation(request, body.organisationId, "viewer", async (tx) => addEquipment(tx, body, await safetyPeopleMap(tx.organisationId)));
  return json({ equipment }, { status: 201 });
});
