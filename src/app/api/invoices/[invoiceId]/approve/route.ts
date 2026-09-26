import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approveInvoice } from "@/lib/invoices/service";

type Context = { params: Promise<{ invoiceId: string }> };

/** Approves a draft: gives it the next invoice number and posts its journal on the invoice date. */
export const POST = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    approveInvoice(tx, invoiceId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
