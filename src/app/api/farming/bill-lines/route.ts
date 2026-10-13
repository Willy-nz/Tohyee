import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { linkableBillLines } from "@/lib/farming/fertiliser";

/** GET: approved bill lines on 6310 Fertiliser and lime or 6320 Fertiliser spreading, for linking to a plan. */
export const GET = route(async (request) => {
  const lines = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => linkableBillLines(tx));
  return json({ lines });
});
