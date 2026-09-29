import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { acceptQuote } from "@/lib/quotes/service";

type Context = { params: Promise<{ quoteId: string }> };

/** Accepts a finalised quote: makes a draft invoice carrying its lines, linked both ways. */
export const POST = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    acceptQuote(tx, quoteId, { source: body.source, idempotencyKey: body.idempotencyKey, invoiceDate: body.invoiceDate, dueDate: body.dueDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
