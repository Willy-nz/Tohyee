import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { listSnapshots, submitForecast } from "@/lib/crm/forecast-teams";

/** Submitted forecasts for a period (decision 499): `period`, `periodStart`. */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const snapshots = await withCrm(request, query.get("organisationId"), "read", (tx, { scope }) =>
    listSnapshots(tx, { period: query.get("period"), periodStart: query.get("periodStart") }, scope),
  );
  return json({ snapshots });
});

/** Submits a forecast for a period, kept as it is now: `period`, `periodStart`, and `ownerUserId` or `teamId` (neither: everyone's), `note`. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const snapshot = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    submitForecast(tx, { period: body.period, periodStart: body.periodStart, ownerUserId: body.ownerUserId, teamId: body.teamId, note: body.note }, scope),
  );
  return json({ snapshot }, { status: 201 });
});
