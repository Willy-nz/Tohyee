import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { copyQuote } from "@/lib/quotes/service";

type Context = { params: Promise<{ quoteId: string }> };

/** Copies a quote into a new draft dated quoteDate. */
export const POST = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    copyQuote(tx, quoteId, { source: body.source, idempotencyKey: body.idempotencyKey, quoteDate: body.quoteDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
