import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { declineQuote } from "@/lib/quotes/service";

type Context = { params: Promise<{ quoteId: string }> };

/** Declines a finalised quote, so it can't be accepted. */
export const POST = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    declineQuote(tx, quoteId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
