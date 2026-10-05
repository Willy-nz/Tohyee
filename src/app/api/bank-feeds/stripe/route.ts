import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { connectStripe, disconnectStripe, getStripeStatus, updateStripeSettings } from "@/lib/bank/stripe/service";
import { closeAllPaymentLinks } from "@/lib/payments/stripe";

/** Whether Stripe is connected, its balances and last sync (the key is never returned). */
export const GET = route(async (request) => {
  const stripe = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getStripeStatus(tx));
  return json({ stripe });
});

/** Connects with a restricted key (`apiKey`, `syncEveryHours`). Admins. The key is checked with Stripe outside any database transaction. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ stripe: await connectStripe(organisation, actor, body) }, { status: 201 });
});

/** Changes how often Stripe is synced (`syncEveryHours`). Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const stripe = await withOrganisation(request, body.organisationId, "admin", (tx) => updateStripeSettings(tx, body));
  return json({ stripe });
});

/**
 * Disconnects: open payment links are switched off first (PN11), then the
 * key is deleted and currencies unlinked. Lines stay. Admins.
 */
export const DELETE = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const { organisation, actor } = await withOrganisation(request, organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const links = await closeAllPaymentLinks(organisation, actor, "Stripe disconnected");
  const stripe = await withOrganisation(request, organisationId, "admin", (tx) => disconnectStripe(tx));
  return json({ stripe, linksNotSwitchedOff: links.failed });
});
