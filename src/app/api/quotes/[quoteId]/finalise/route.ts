import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { finaliseQuote } from "@/lib/quotes/service";

type Context = { params: Promise<{ quoteId: string }> };

/** Finalises a draft: gives it the next QU- number and locks it. */
export const POST = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    finaliseQuote(tx, quoteId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
