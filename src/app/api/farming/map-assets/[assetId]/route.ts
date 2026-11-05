import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { removeMapAsset, updateMapAsset } from "@/lib/farming/map-assets";

type Context = { params: Promise<{ assetId: string }> };

/** Changes a map asset's kind, name, note, or place (`point` or `line`). Farm staff and up (MA3). */
export const PATCH = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const asset = await withFarmWork(request, body.organisationId, "record", (tx) => updateMapAsset(tx, assetId, { kind: body.kind, name: body.name, note: body.note, point: body.point, line: body.line }));
  return json({ asset });
});

/** Takes an asset off the map; it's kept, with who and when. Farm staff and up (MA3). */
export const DELETE = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  await withFarmWork(request, searchParams(request).get("organisationId"), "record", (tx) => removeMapAsset(tx, assetId));
  return json({ ok: true });
});
