import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setActivityArchived } from "@/lib/rd/register";

type Context = { params: Promise<{ activityId: string }> };

/** POST: archives an activity, or restores it with `{ archived: false }` (admins and above). Activities are never deleted. */
export const POST = route<Context>(async (request, context) => {
  const { activityId } = await context.params;
  const body = await readJson(request);
  const activity = await withOrganisation(request, body.organisationId, "admin", (tx) => setActivityArchived(tx, activityId, body.archived ?? true));
  return json({ activity });
});
