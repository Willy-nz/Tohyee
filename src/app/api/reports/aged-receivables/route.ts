import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { agedReceivables } from "@/lib/reports/aged-receivables";

/** Aged receivables as at `asAt`; `rollUp=true` adds each parent customer's total with its subs (examples RC9-RC11). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    agedReceivables(tx, { asAt: params.get("asAt"), rollUp: params.get("rollUp") }),
  );
  return json(report);
});
