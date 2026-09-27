import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listOverpayments } from "@/lib/invoices/overpayments";

/**
 * GET: payments with an overpayment, newest first. Optional filters:
 * `contactId` (one customer's) and `hasRemainingCredit=true` (only active
 * overpayments with some left to apply or refund).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const overpayments = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listOverpayments(tx, {
      contactId: params.get("contactId"),
      hasRemainingCredit: params.get("hasRemainingCredit"),
    }),
  );
  return json({ overpayments });
});
