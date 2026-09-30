import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createRepeatingBill, listRepeatingBills } from "@/lib/repeating/bills";

/** GET: every repeating bill template, newest first. Filters: status (active|paused|ended), contactId. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listRepeatingBills(tx, { status: params.get("status"), contactId: params.get("contactId") }),
  );
  return json(result);
});

/** Saves a repeating bill template. It posts nothing; the job makes its bills. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createRepeatingBill(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
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
  return json(result, { status: result.created ? 201 : 200 });
});
