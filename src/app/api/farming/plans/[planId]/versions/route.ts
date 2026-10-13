import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { savePlanVersion } from "@/lib/farming/fertiliser";

type Context = { params: Promise<{ planId: string }> };

/** Saves a new version of the plan (`lines`, `spreadingPerHa`, `note`). Earlier versions are kept. */
export const POST = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  const body = await readJson(request);
  const report = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => savePlanVersion(tx, planId, { lines: body.lines, spreadingPerHa: body.spreadingPerHa, note: body.note }));
  return json({ report }, { status: 201 });
});
