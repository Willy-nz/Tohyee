import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listTopBarNotices } from "@/lib/notices/top-bar";

/** GET: non-blocking notices shown in the top bar. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const notices = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listTopBarNotices(tx));
  return json({ notices });
});
