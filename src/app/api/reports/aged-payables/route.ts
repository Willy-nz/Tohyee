import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { agedPayables } from "@/lib/reports/aged-payables";

/** Aged payables as at `asAt`: what's owed to each supplier by days past due, less unused supplier credit (examples AGP1-AGP3). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => agedPayables(tx, { asAt: params.get("asAt") }));
  return json(report);
});
