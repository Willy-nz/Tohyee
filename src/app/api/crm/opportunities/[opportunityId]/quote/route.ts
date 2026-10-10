import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { makeQuoteFromDeal } from "@/lib/crm/deal-lines";

type Context = { params: Promise<{ opportunityId: string }> };

/**
 * Makes a draft quote from a deal's products (DS7), replacing its open quote
 * if it has one (DS8): `idempotencyKey`, and optionally `quoteDate` and
 * `expiryDate`. Quotes are in the books, so it needs the bookkeeper role.
 */
export const POST = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    makeQuoteFromDeal(tx, opportunityId, { idempotencyKey: body.idempotencyKey, quoteDate: body.quoteDate, expiryDate: body.expiryDate }),
  );
  return json(result, { status: 201 });
});
