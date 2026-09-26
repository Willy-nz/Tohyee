import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteInvoice, getInvoice, updateInvoice } from "@/lib/invoices/service";

type Context = { params: Promise<{ invoiceId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { invoiceId } = await context.params;
  const invoice = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getInvoice(tx, invoiceId),
  );
  return json({ invoice });
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
