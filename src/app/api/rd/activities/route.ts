import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { rdSettings } from "@/lib/rd/common";
import { createActivity, listActivities } from "@/lib/rd/register";

/**
 * GET: the R&D activity register (viewers and above); `includeArchived=1` for
 * archived activities too. `yearEndMonth` is the balance date month, for
 * income year labels.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => ({
    activities: await listActivities(tx, { includeArchived: params.get("includeArchived") === "1" }),
    yearEndMonth: (await rdSettings(tx)).yearEndMonth,
  }));
  return json(result);
});

/** POST: adds an activity to the register (bookkeepers and above; RD1, RD2). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createActivity(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
