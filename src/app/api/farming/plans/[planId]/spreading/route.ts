import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { linkSpreading, unlinkSpreading } from "@/lib/farming/fertiliser";

type Context = { params: Promise<{ planId: string }> };

/** Links a spreading bill line to the applications it covered (`billLineId`, `applicationIds`); shared by hectares for reports. */
export const POST = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  const body = await readJson(request);
  const report = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => linkSpreading(tx, planId, { billLineId: body.billLineId, applicationIds: body.applicationIds }));
  return json({ report });
});

/** Unlinks a spreading bill line (`billLineId` in the query). */
export const DELETE = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) => unlinkSpreading(tx, planId, { billLineId: params.get("billLineId") }));
  return json({ report });
});
