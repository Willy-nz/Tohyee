import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createCreditNote, listCreditNotes } from "@/lib/credit-notes/service";

/**
 * GET: newest first, 50 at a time. Filters: status (draft|approved|voided),
 * contactId (one customer's credit notes), hasRemainingCredit (true: approved
 * credit notes with credit left to apply or refund), beforeId (next page),
 * limit (max 200).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listCreditNotes(tx, {
      status: params.get("status"),
      contactId: params.get("contactId"),
      hasRemainingCredit: params.get("hasRemainingCredit"),
      beforeId: params.get("beforeId"),
      limit: params.get("limit"),
    }),
  );
  return json(result);
});

/** Saves a draft credit note. Drafts post nothing and have no number until they're approved. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createCreditNote(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      contactId: body.contactId,
      creditNoteDate: body.creditNoteDate,
      reference: body.reference,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
      salespersonId: body.salespersonId,
      returnInvoiceId: body.returnInvoiceId,
      exchangeRate: body.exchangeRate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
