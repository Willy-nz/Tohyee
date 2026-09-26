import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidInvoice } from "@/lib/invoices/service";

type Context = { params: Promise<{ invoiceId: string }> };

/** Voids an approved invoice: posts the exact reversal of its journal on `voidDate`. */
export const POST = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidInvoice(tx, invoiceId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
