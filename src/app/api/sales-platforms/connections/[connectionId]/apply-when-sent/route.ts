import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { applyWhenSentToInvoiced, ordersToApplyWhenSent } from "@/lib/sales-platforms/apply-when-sent";

/** GET: Shopify orders invoiced to sales before Sales when sent applied to them, not yet fully sent (SWS13). Bookkeepers. */
export const GET = route<{ params: Promise<{ connectionId: string }> }>(async (request, context) => {
  const { connectionId } = await context.params;
  const preview = await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => ordersToApplyWhenSent(tx, connectionId));
  return json(preview);
});

/** POST: marks the chosen orders (`orderIds`) so the next sync holds what's still to be sent. Bookkeepers. */
export const POST = route<{ params: Promise<{ connectionId: string }> }>(async (request, context) => {
  const { connectionId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => applyWhenSentToInvoiced(tx, { connectionId, orderIds: body.orderIds }));
  return json(result);
});
