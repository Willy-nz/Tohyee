import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { disablePayPalPayNow, enablePayPalPayNow, getPayPalPayNowStatus } from "@/lib/payments/paypal";
import { disableOnlinePayments, enableOnlinePayments, getOnlinePaymentStatus } from "@/lib/payments/stripe";

/**
 * GET: whether Pay now with Stripe (PN1) and Pay with PayPal (PPN1) are on,
 * their last checks, and payments waiting for a person. Viewers and above.
 */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => ({
    payments: await getOnlinePaymentStatus(tx),
    paypal: await getPayPalPayNowStatus(tx),
  }));
  return json(result);
});

/**
 * PUT `{ enabled, provider }` (provider "stripe", the default, or "paypal"):
 * turns it on (needs that provider's connection) or off (open links are
 * switched off first, PN11, PPN9). Admins.
 */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  if (typeof body.enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
  const provider = body.provider ?? "stripe";
  if (provider !== "stripe" && provider !== "paypal") throw new ValidationError("provider must be stripe or paypal.");
  if (body.enabled) {
    await withOrganisation(request, body.organisationId, "admin", async (tx) => {
      if (provider === "paypal") await enablePayPalPayNow(tx);
      else await enableOnlinePayments(tx);
    });
    return json({ ...(await statuses(request, body.organisationId)), linksNotSwitchedOff: [] });
  }
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = provider === "paypal" ? await disablePayPalPayNow(organisation, actor) : await disableOnlinePayments(organisation, actor);
  return json({ ...(await statuses(request, body.organisationId)), linksNotSwitchedOff: result.failed });
});

function statuses(request: Request, organisationId: unknown) {
  return withOrganisation(request, organisationId, "viewer", async (tx) => ({
    payments: await getOnlinePaymentStatus(tx),
    paypal: await getPayPalPayNowStatus(tx),
  }));
}
