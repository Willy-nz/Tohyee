import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { linkPurchase, unlinkPurchase } from "@/lib/farming/fertiliser";

type Context = { params: Promise<{ planId: string }> };

/** Links an approved bill line to the plan as product bought (`billLineId`, `productId`, `tonnes`). Posts nothing. */
export const POST = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  const body = await readJson(request);
  const report = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => linkPurchase(tx, planId, { billLineId: body.billLineId, productId: body.productId, tonnes: body.tonnes }));
  return json({ report });
});

/** Unlinks a bill line (`billLineId` in the query). The bill itself is unchanged. */
export const DELETE = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) => unlinkPurchase(tx, planId, { billLineId: params.get("billLineId") }));
  return json({ report });
});
