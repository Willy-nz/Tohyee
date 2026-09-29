import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { runRepeatingInvoiceNow } from "@/lib/repeating/service";

type Context = { params: Promise<{ repeatingInvoiceId: string }> };

/** Makes this template's invoices that are due up to today now, as the hourly job would. */
export const POST = route<Context>(async (request, context) => {
  const { repeatingInvoiceId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => runRepeatingInvoiceNow(tx, repeatingInvoiceId));
  return json(result);
});
