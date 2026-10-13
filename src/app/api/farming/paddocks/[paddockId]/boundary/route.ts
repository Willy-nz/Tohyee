import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setBoundary } from "@/lib/farming/paddocks";

type Context = { params: Promise<{ paddockId: string }> };

/** A new version of a paddock's boundary (GeoJSON `geometry`); earlier versions are kept. */
export const POST = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const body = await readJson(request);
  const paddock = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setBoundary(tx, paddockId, { geometry: body.geometry, source: body.source }));
  return json({ paddock }, { status: 201 });
});
