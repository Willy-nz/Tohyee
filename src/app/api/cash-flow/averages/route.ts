import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listCashFlowAverages, setCashFlowAverages } from "@/lib/cash-flow/forecast";

/** GET: the accounts forecast from their average (CF6). Viewers and above. */
export const GET = route(async (request) => {
  const averages = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listCashFlowAverages(tx));
  return json({ averages });
});

/** PUT `{ averages: [{ accountId, direction, months }] }`: replaces them. Bookkeepers. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const averages = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setCashFlowAverages(tx, body.averages));
  return json({ averages });
});
