import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createBillFromInboxItem } from "@/lib/bills/inbox";
import { createBill, listBills } from "@/lib/bills/service";

/**
 * GET: newest first, 50 at a time. Filters: status (draft|approved|voided),
 * awaitingPayment (true: approved bills with something still due), contactId
 * (one supplier's bills), beforeId (next page), limit (max 200).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listBills(tx, {
      status: params.get("status"),
      awaitingPayment: params.get("awaitingPayment"),
      contactId: params.get("contactId"),
      beforeId: params.get("beforeId"),
      limit: params.get("limit"),
    }),
  );
  return json(result);
});

/**
 * Saves a draft bill. Drafts post nothing until they're approved. With
 * `inboxItemId`, it's made from a bills inbox item: the item's file is
 * attached and the item leaves the waiting list (BI3).
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) => {
    const input = {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      contactId: body.contactId,
      billDate: body.billDate,
      dueDate: body.dueDate,
      supplierInvoiceNumber: body.supplierInvoiceNumber,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
      exchangeRate: body.exchangeRate,
    };
    return body.inboxItemId != null && body.inboxItemId !== ""
      ? createBillFromInboxItem(tx, membership.role, body.inboxItemId, input, { foreignCurrency: true })
      : createBill(tx, input, null, { foreignCurrency: true });
  });
  return json(result, { status: result.created ? 201 : 200 });
});
