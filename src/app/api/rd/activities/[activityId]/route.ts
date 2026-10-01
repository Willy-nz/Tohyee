import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getActivity, updateActivity } from "@/lib/rd/register";

type Context = { params: Promise<{ activityId: string }> };

/** GET: an activity with its approvals, files and history (viewers and above). */
export const GET = route<Context>(async (request, context) => {
  const { activityId } = await context.params;
  const activity = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getActivity(tx, activityId));
  return json({ activity });
});

/** PATCH: changes an activity (bookkeepers and above); the old version stays in its history. */
export const PATCH = route<Context>(async (request, context) => {
  const { activityId } = await context.params;
  const body = await readJson(request);
  const activity = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateActivity(tx, activityId, body));
  return json({ activity });
});
