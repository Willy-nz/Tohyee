import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { teamForecast } from "@/lib/crm/forecast-teams";

/**
 * The forecast (CRMS8, CRMS9): `period` month or quarter, `from` a date in
 * the first period (today when not given), `periods` how many, and
 * optionally one `ownerUserId` ("none" for no owner). With adjustments in
 * place and sales team roll-ups (decision 499). Read-only.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withCrm(request, params.get("organisationId"), "read", (tx, { scope }) =>
    teamForecast(tx, { period: params.get("period"), from: params.get("from"), periods: params.get("periods"), ownerUserId: params.get("ownerUserId") }, scope),
  );
  return json({ forecast: result });
});
