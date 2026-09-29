import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { salesBySalesperson } from "@/lib/reports/sales-by-salesperson";

/** Sales by salesperson between `from` and `to`, excluding GST (examples SR3-SR5, SR8). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    salesBySalesperson(tx, { from: params.get("from"), to: params.get("to") }),
  );
  return json(report);
});
