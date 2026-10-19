import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { farmHome } from "@/lib/farming/home";

/**
 * GET ?organisationId=: the farm Home's cards (#341; FH1-FH8). Each is null
 * when there's nothing to show. The calendar card is the signed-in
 * member's own (and what others shared), like the calendar itself.
 */
export const GET = route(async (request) => {
  const home = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => farmHome(tx));
  return json(home);
});
