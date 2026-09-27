import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listInvoiceCredit } from "@/lib/credit-notes/applications";
import { deleteInvoice, getInvoice, updateInvoice } from "@/lib/invoices/service";

type Context = { params: Promise<{ invoiceId: string }> };

/** GET: the invoice, and the credit applied to it from credit notes (active and removed, oldest first). */
export const GET = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    const invoice = await getInvoice(tx, invoiceId);
    return { invoice, creditApplied: await listInvoiceCredit(tx, invoice.id) };
  });
  return json(result);
});

/** Edits a draft. Fields left out keep their values; `lines` replaces every line. */
export const PATCH = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const body = await readJson(request);
  const invoice = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateInvoice(tx, invoiceId, {
      contactId: body.contactId,
      invoiceDate: body.invoiceDate,
      dueDate: body.dueDate,
      reference: body.reference,
      amountsMode: body.amountsMode,
      lines: body.lines,
    }),
  );
  return json({ invoice });
});

/** Deletes a draft. Approved invoices are voided instead. */
export const DELETE = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) =>
    deleteInvoice(tx, invoiceId),
  );
  return json({ ok: true });
});
