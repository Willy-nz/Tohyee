import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { disableOnlinePayments, enableOnlinePayments, getOnlinePaymentStatus } from "@/lib/payments/stripe";

/** GET: whether Pay now with Stripe is on, the last check, and payments waiting for a person (PN1, PN10). Viewers and above. */
export const GET = route(async (request) => {
  const payments = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getOnlinePaymentStatus(tx));
  return json({ payments });
});

/**
 * PUT `{ enabled }`: turns Pay now with Stripe on (needs a Stripe connection)
 * or off (open links are switched off first, PN11). Admins.
 */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  if (typeof body.enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
  if (body.enabled) {
    const payments = await withOrganisation(request, body.organisationId, "admin", (tx) => enableOnlinePayments(tx));
    return json({ payments, linksNotSwitchedOff: [] });
  }
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await disableOnlinePayments(organisation, actor);
  return json({ payments: result.status, linksNotSwitchedOff: result.failed });
});
