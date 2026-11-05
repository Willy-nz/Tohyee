import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { memberActivity } from "@/lib/organisations/activity";

type Context = { params: Promise<{ organisationId: string; userId: string }> };

/** GET: what one member did in this organisation (decision 1472), newest first; `before` for older. Owners and admins. */
export const GET = route<Context>(async (request, context) => {
  const params = await context.params;
  const activity = await withOrganisation(request, params.organisationId, "admin", (tx) => memberActivity(tx, params.userId, searchParams(request).get("before")));
  return json(activity);
});
