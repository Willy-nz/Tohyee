import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getRepeatingInvoice, updateRepeatingInvoice } from "@/lib/repeating/service";

type Context = { params: Promise<{ repeatingInvoiceId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { repeatingInvoiceId } = await context.params;
  const repeatingInvoice = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getRepeatingInvoice(tx, repeatingInvoiceId),
  );
  return json({ repeatingInvoice });
});

/** Changes a template. Invoices already made keep what they had. */
export const PATCH = route<Context>(async (request, context) => {
  const { repeatingInvoiceId } = await context.params;
  const body = await readJson(request);
  const repeatingInvoice = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateRepeatingInvoice(tx, repeatingInvoiceId, {
      contactId: body.contactId,
      reference: body.reference,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
      salespersonId: body.salespersonId,
      period: body.period,
      every: body.every,
      startDate: body.startDate,
      endDate: body.endDate,
      dueRule: body.dueRule,
      dueDays: body.dueDays,
      saveAs: body.saveAs,
    }),
  );
  return json({ repeatingInvoice });
});
