import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidOverpaymentRefund } from "@/lib/invoices/overpayments";

type Context = { params: Promise<{ paymentId: string; refundId: string }> };

/** Voids a refund on `voidDate`: posts the exact reversal, and the credit is available again. */
export const POST = route<Context>(async (request, context) => {
  const { paymentId, refundId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidOverpaymentRefund(tx, paymentId, refundId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      voidDate: body.voidDate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
