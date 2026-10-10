import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { adjustForecast, adjustmentHistory } from "@/lib/crm/forecast-teams";

/** Every adjustment of someone's period (decision 499): `ownerUserId`, `period`, `periodStart`. */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const history = await withCrm(request, query.get("organisationId"), "read", (tx, { scope }) =>
    adjustmentHistory(tx, { ownerUserId: query.get("ownerUserId"), period: query.get("period"), periodStart: query.get("periodStart") }, scope),
  );
  return json({ history });
});

/**
 * Adjusts someone's Commit or Best case (decision 499): `ownerUserId`,
 * `period`, `periodStart`, `currencyCode`, `measure` ("commit" or
 * "bestCase"), `amount` (none clears it) and `reason`. Their team manager,
 * or an admin or owner.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    adjustForecast(
      tx,
      { ownerUserId: body.ownerUserId, period: body.period, periodStart: body.periodStart, currencyCode: body.currencyCode, measure: body.measure, amount: body.amount, reason: body.reason },
      scope,
    ),
  );
  return json(result);
});
