import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createInvoice, listInvoices } from "@/lib/invoices/service";

/**
 * GET: newest first, 50 at a time. Filters: status (draft|approved|voided),
 * awaitingPayment (true: approved invoices with something still due), contactId
 * (one customer's invoices), beforeId (next page), limit (max 200).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listInvoices(tx, {
      status: params.get("status"),
      awaitingPayment: params.get("awaitingPayment"),
      contactId: params.get("contactId"),
      beforeId: params.get("beforeId"),
      limit: params.get("limit"),
    }),
  );
  return json(result);
});

/** Saves a draft invoice. Drafts post nothing until they're approved. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createInvoice(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      contactId: body.contactId,
      invoiceDate: body.invoiceDate,
      dueDate: body.dueDate,
      reference: body.reference,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
