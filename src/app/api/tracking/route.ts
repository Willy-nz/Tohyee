import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getTrackingSetup } from "@/lib/tracking/service";

/** GET: whether advanced features are on, and the tracking categories with their values (examples TC1, TC2). */
export const GET = route(async (request) => {
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getTrackingSetup(tx));
  return json(setup);
});
