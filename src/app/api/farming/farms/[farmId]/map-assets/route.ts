import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addMapAsset, listMapAssets } from "@/lib/farming/map-assets";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's map assets (points and lines). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const assets = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => listMapAssets(tx, farmId));
  return json({ assets });
});

/** Adds a map asset (`kind`, `name`, `note`, and `point` [longitude, latitude] or `line` [[longitude, latitude], ...]). Farm staff and up (MA1-MA2). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const asset = await withFarmWork(request, body.organisationId, "record", (tx) => addMapAsset(tx, { farmId, kind: body.kind, name: body.name, note: body.note, point: body.point, line: body.line }));
  return json({ asset }, { status: 201 });
});
