import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createRepeatingInvoice, listRepeatingInvoices } from "@/lib/repeating/service";

/** GET: every template, newest first. Filters: status (active|paused|ended), contactId. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listRepeatingInvoices(tx, { status: params.get("status"), contactId: params.get("contactId") }),
  );
  return json(result);
});

/** Saves a repeating invoice template. It posts nothing; the job makes its invoices. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createRepeatingInvoice(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
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
  return json(result, { status: result.created ? 201 : 200 });
});
