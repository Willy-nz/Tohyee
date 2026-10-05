import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { checkPayPalPayments, getPayPalPayNowStatus } from "@/lib/payments/paypal";
import { checkOnlinePayments, getOnlinePaymentStatus } from "@/lib/payments/stripe";

/**
 * POST: checks for payments now (Check now, PN3, PPN3): Stripe and PayPal,
 * whichever are on, outside a long transaction. Bookkeepers and above.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor, stripeOn, payPalOn } = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
    stripeOn: (await getOnlinePaymentStatus(tx)).enabled,
    payPalOn: (await getPayPalPayNowStatus(tx)).enabled,
  }));
  const check = stripeOn ? await checkOnlinePayments(organisation, actor) : null;
  const paypalCheck = payPalOn ? await checkPayPalPayments(organisation, actor) : null;
  const result = await withOrganisation(request, body.organisationId, "viewer", async (tx) => ({
    payments: await getOnlinePaymentStatus(tx),
    paypal: await getPayPalPayNowStatus(tx),
  }));
  return json({ check, paypalCheck, ...result });
});
