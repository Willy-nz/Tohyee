import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteBill, getBill, updateBill } from "@/lib/bills/service";
import { listBillCredit } from "@/lib/supplier-credit-notes/applications";

type Context = { params: Promise<{ billId: string }> };

/** GET: the bill, and the credit applied to it from supplier credit notes (active and removed, oldest first). */
export const GET = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    const bill = await getBill(tx, billId);
    return { bill, creditApplied: await listBillCredit(tx, bill.id) };
  });
  return json(result);
});

/** Edits a draft. Fields left out keep their values; `lines` replaces every line. */
export const PATCH = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  const body = await readJson(request);
  const bill = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateBill(tx, billId, {
      contactId: body.contactId,
      billDate: body.billDate,
      dueDate: body.dueDate,
      supplierInvoiceNumber: body.supplierInvoiceNumber,
      amountsMode: body.amountsMode,
      lines: body.lines,
    }),
  );
  return json({ bill });
});

/** Deletes a draft. Approved bills are voided instead. */
export const DELETE = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) =>
    deleteBill(tx, billId),
  );
  return json({ ok: true });
});
