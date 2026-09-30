import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getRepeatingBill, updateRepeatingBill } from "@/lib/repeating/bills";

type Context = { params: Promise<{ repeatingBillId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { repeatingBillId } = await context.params;
  const repeatingBill = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getRepeatingBill(tx, repeatingBillId),
  );
  return json({ repeatingBill });
});

/** Changes a template. Bills already made keep what they had. */
export const PATCH = route<Context>(async (request, context) => {
  const { repeatingBillId } = await context.params;
  const body = await readJson(request);
  const repeatingBill = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateRepeatingBill(tx, repeatingBillId, {
      contactId: body.contactId,
      supplierInvoiceNumber: body.supplierInvoiceNumber,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
      period: body.period,
      every: body.every,
      startDate: body.startDate,
      endDate: body.endDate,
      dueRule: body.dueRule,
      dueDays: body.dueDays,
      saveAs: body.saveAs,
    }),
  );
  return json({ repeatingBill });
});
