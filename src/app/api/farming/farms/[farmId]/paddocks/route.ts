import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addPaddock, listPaddocks } from "@/lib/farming/paddocks";

type Context = { params: Promise<{ farmId: string }> };

/** GET: a farm's paddocks with their current boundaries (`includeRetired=true` adds retired ones). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const paddocks = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listPaddocks(tx, { farmId, includeRetired: params.get("includeRetired") }));
  return json({ paddocks });
});

/** Adds a paddock: `name`, `effectiveHa`, optional GeoJSON `geometry` and `onDate`. */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const paddock = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addPaddock(tx, { farmId, name: body.name, effectiveHa: body.effectiveHa, geometry: body.geometry, onDate: body.onDate }),
  );
  return json({ paddock }, { status: 201 });
});
