import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeCashFlowItem, updateCashFlowItem } from "@/lib/cash-flow/forecast";

type Context = { params: Promise<{ itemId: string }> };

/** PUT: changes a forecast item; `version` is the one read. Bookkeepers. */
export const PUT = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateCashFlowItem(tx, itemId, body));
  return json({ item });
});

/** DELETE: removes a forecast item (kept with its history). Bookkeepers. */
export const DELETE = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeCashFlowItem(tx, itemId));
  return json({ removed: true });
});
