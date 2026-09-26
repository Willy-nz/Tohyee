import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidPayment } from "@/lib/invoices/payments";

type Context = { params: Promise<{ invoiceId: string; paymentId: string }> };

/** Voids a payment: posts the exact reversal of its journal on `voidDate`, so the amount is due again. */
export const POST = route<Context>(async (request, context) => {
  const { invoiceId, paymentId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidPayment(tx, invoiceId, paymentId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      voidDate: body.voidDate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
