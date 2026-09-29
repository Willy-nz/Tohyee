import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createQuote, listQuotes } from "@/lib/quotes/service";

/** GET: newest first. Filters: status (draft|finalised|expired|accepted|declined), contactId, beforeId. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listQuotes(tx, { status: params.get("status"), contactId: params.get("contactId"), beforeId: params.get("beforeId") }),
  );
  return json(result);
});

/** Saves a draft quote. Quotes post nothing. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createQuote(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      contactId: body.contactId,
      quoteDate: body.quoteDate,
      expiryDate: body.expiryDate,
      reference: body.reference,
      terms: body.terms,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
      salespersonId: body.salespersonId,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
