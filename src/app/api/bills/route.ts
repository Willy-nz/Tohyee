import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createBill, listBills } from "@/lib/bills/service";

/**
 * GET: newest first, 50 at a time. Filters: status (draft|approved|voided),
 * awaitingPayment (true: approved bills with something still due), beforeId
 * (next page), limit (max 200).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listBills(tx, {
      status: params.get("status"),
      awaitingPayment: params.get("awaitingPayment"),
      beforeId: params.get("beforeId"),
      limit: params.get("limit"),
    }),
  );
  return json(result);
});

/** Saves a draft bill. Drafts post nothing until they're approved. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createBill(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      contactId: body.contactId,
      billDate: body.billDate,
      dueDate: body.dueDate,
      supplierInvoiceNumber: body.supplierInvoiceNumber,
      amountsMode: body.amountsMode,
      lines: body.lines,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
