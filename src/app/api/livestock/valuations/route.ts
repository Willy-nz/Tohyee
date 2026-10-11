import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listValuations } from "@/lib/livestock/valuation";

/** GET: approved and replaced valuations, newest first. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const valuations = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listValuations(tx));
  return json({ valuations });
});
