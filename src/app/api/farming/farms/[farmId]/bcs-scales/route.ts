import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { listScales, setScale } from "@/lib/farming/bcs";

type Context = { params: Promise<{ farmId: string }> };

/** GET: each kind's BCS scale on the farm, its descriptions, targets and which scores have reference photos (decisions 1487, 1493). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const scales = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => listScales(tx, { farmId }));
  return json({ scales });
});

/** PUT `{ kind, scale }`: an admin changes a kind's scale (checked in the service). */
export const PUT = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const scales = await withFarmWork(request, body.organisationId, "record", (tx) => setScale(tx, { farmId, kind: body.kind, scale: body.scale }));
  return json({ scales });
});
