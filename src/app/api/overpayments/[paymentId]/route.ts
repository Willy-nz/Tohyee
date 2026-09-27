import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getOverpayment } from "@/lib/invoices/overpayments";

type Context = { params: Promise<{ paymentId: string }> };

/** GET: the payment with its overpayment: how much, and how much is applied, refunded and left. */
export const GET = route<Context>(async (request, context) => {
  const { paymentId } = await context.params;
  const payment = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getOverpayment(tx, paymentId),
  );
  return json({ payment });
});
