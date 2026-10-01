import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { forecast } from "@/lib/crm/forecast";

/**
 * The forecast (CRMS8, CRMS9): `period` month or quarter, `from` a date in
 * the first period (today when not given), `periods` how many, and
 * optionally one `ownerUserId` ("none" for no owner). Read-only.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    forecast(tx, { period: params.get("period"), from: params.get("from"), periods: params.get("periods"), ownerUserId: params.get("ownerUserId") }),
  );
  return json({ forecast: result });
});
