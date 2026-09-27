import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidSupplierPayment } from "@/lib/bills/payments";

type Context = { params: Promise<{ billId: string; paymentId: string }> };

/** Voids a payment: posts the exact reversal of its journal on `voidDate`, so the amount is due again. */
export const POST = route<Context>(async (request, context) => {
  const { billId, paymentId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidSupplierPayment(tx, billId, paymentId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      voidDate: body.voidDate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
