import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { updateGauge } from "@/lib/farming/rainfall";

type Context = { params: Promise<{ gaugeId: string }> };

/** Renames a rain gauge, changes its note or place (`point`, null to take it off the map), or retires it or brings it back (`isActive`). Farm staff and up (RF1). */
export const PATCH = route<Context>(async (request, context) => {
  const { gaugeId } = await context.params;
  const body = await readJson(request);
  const gauge = await withFarmWork(request, body.organisationId, "record", (tx) => updateGauge(tx, gaugeId, { name: body.name, note: body.note, point: body.point, isActive: body.isActive }));
  return json({ gauge });
});
