import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { mergePaddocks } from "@/lib/farming/paddocks";

/** Merges `paddockIds` into one new paddock (`name`, `effectiveHa`, optional `geometry`) on `onDate`. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const paddocks = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    mergePaddocks(tx, { paddockIds: body.paddockIds, onDate: body.onDate, name: body.name, effectiveHa: body.effectiveHa, geometry: body.geometry }),
  );
  return json({ paddocks }, { status: 201 });
});
