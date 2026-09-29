import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteQuote, getQuote, updateQuote } from "@/lib/quotes/service";

type Context = { params: Promise<{ quoteId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const quote = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getQuote(tx, quoteId));
  return json({ quote });
});

/** Edits a draft quote. Fields left out keep their values; `lines` replaces every line. */
export const PATCH = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const body = await readJson(request);
  const quote = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateQuote(tx, quoteId, {
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
  return json({ quote });
});

/** Deletes a draft quote. Finalised quotes are declined instead. */
export const DELETE = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteQuote(tx, quoteId));
  return json({ ok: true });
});
