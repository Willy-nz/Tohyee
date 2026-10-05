import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createCashFlowItem, listCashFlowItems } from "@/lib/cash-flow/forecast";

/** GET: forecast items (CF4). Viewers and above. */
export const GET = route(async (request) => {
  const items = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listCashFlowItems(tx));
  return json({ items });
});

/** POST: adds a forecast item: money in or out, once or every week or month until a date. Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createCashFlowItem(tx, body));
  return json({ item }, { status: 201 });
});
