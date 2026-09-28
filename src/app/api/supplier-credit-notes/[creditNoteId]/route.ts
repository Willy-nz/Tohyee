import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import {
  deleteSupplierCreditNote,
  getSupplierCreditNote,
  updateSupplierCreditNote,
} from "@/lib/supplier-credit-notes/service";

type Context = { params: Promise<{ creditNoteId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const creditNote = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getSupplierCreditNote(tx, creditNoteId),
  );
  return json({ creditNote });
});

/** Edits a draft. Fields left out keep their values; `lines` replaces every line. */
export const PATCH = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const body = await readJson(request);
  const creditNote = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateSupplierCreditNote(tx, creditNoteId, {
      contactId: body.contactId,
      creditNoteDate: body.creditNoteDate,
      supplierCreditNoteNumber: body.supplierCreditNoteNumber,
      reference: body.reference,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
    }),
  );
  return json({ creditNote });
});

/** Deletes a draft. Approved supplier credit notes are voided instead. */
export const DELETE = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) =>
    deleteSupplierCreditNote(tx, creditNoteId),
  );
  return json({ ok: true });
});
