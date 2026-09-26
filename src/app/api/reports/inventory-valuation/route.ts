import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { inventoryValuation } from "@/lib/reports/financial";

export const GET = route(async (request) => {
  const report = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    inventoryValuation(tx),
  );
  return json(report);
});
