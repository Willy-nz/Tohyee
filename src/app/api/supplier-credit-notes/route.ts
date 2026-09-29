import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createSupplierCreditNote, listSupplierCreditNotes } from "@/lib/supplier-credit-notes/service";

/**
 * GET: newest first, 50 at a time. Filters: status (draft|approved|voided),
 * contactId (one supplier's credit notes), hasRemainingCredit (true: approved
 * supplier credit notes with credit left to apply or refund), beforeId (next
 * page), limit (max 200).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listSupplierCreditNotes(tx, {
      status: params.get("status"),
      contactId: params.get("contactId"),
      hasRemainingCredit: params.get("hasRemainingCredit"),
      beforeId: params.get("beforeId"),
      limit: params.get("limit"),
    }),
  );
  return json(result);
});

/** Saves a draft supplier credit note. Drafts post nothing until they're approved. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createSupplierCreditNote(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      contactId: body.contactId,
      creditNoteDate: body.creditNoteDate,
      supplierCreditNoteNumber: body.supplierCreditNoteNumber,
      reference: body.reference,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
