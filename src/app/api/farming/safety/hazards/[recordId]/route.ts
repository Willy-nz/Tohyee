import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { changeHazard } from "@/lib/safety/hazards";

type Context = { params: Promise<{ recordId: string }> };

/**
 * A new version of a hazard: `change` is "updated", "corrected" or
 * "withdrawn", with `expectedVersion` (the version the person opened) and
 * `why` for a correction, withdrawal, removal or review.
 */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const hazard = await withOrganisation(request, body.organisationId, "viewer", (tx) => changeHazard(tx, recordId, body as never));
  return json({ hazard });
});
