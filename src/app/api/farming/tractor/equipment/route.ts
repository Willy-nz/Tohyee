import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addTractorEquipment, listTractorEquipment } from "@/lib/farming/tractor";

/** GET: tractor mode's spreaders, sprayers and mowers with their current width and offsets, and each change (`includeRetired=true` adds retired ones). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const equipment = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listTractorEquipment(tx, { includeRetired: params.get("includeRetired") === "true" }));
  return json({ equipment });
});

/** Adds equipment: `name`, `kind`, `widthM`, `lateralM`, `backM`, optional `safetyEquipmentId` and `fixedAssetId` (bookkeeper and above). Farm staff and bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const equipment = await withFarmWork(request, body.organisationId, "record", (tx) => addTractorEquipment(tx, body));
  return json({ equipment }, { status: 201 });
});
