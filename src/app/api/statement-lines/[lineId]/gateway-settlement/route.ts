import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { settleGatewayDeposit, settlementGuidanceForLine } from "@/lib/sales-platforms/gateway-settlements";

type Context = { params: Promise<{ lineId: string }> };

/** GET: whether a deposit is a payment gateway's settlement (Afterpay, say) and the order payments it could settle (GS1-GS3). Read-only. */
export const GET = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const guidance = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => settlementGuidanceForLine(tx, lineId));
  return json({ guidance });
});

/** POST: settles the deposit against the chosen payments, with the fee (GS4). Bookkeepers. */
export const POST = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    settleGatewayDeposit(tx, lineId, { paymentIds: body.paymentIds, feesAccountCode: body.feesAccountCode, idempotencyKey: body.idempotencyKey }),
  );
  return json(result);
});
