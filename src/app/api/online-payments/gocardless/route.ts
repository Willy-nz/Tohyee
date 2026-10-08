import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { connectGoCardless, disconnectGoCardless, getGoCardlessStatus, updateGoCardlessSettings } from "@/lib/payments/gocardless";

/** Whether GoCardless direct debit is connected and on, its accounts, last check and failed collections (the token is never returned). Viewers. */
export const GET = route(async (request) => {
  const gocardless = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getGoCardlessStatus(tx));
  return json({ gocardless });
});

/** GC1: connects with an access `token` (`environment` "live" or "sandbox"), checked with GoCardless outside any transaction. Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ gocardless: await connectGoCardless(organisation, actor, body) }, { status: 201 });
});

/** `{ enabled, clearingAccountCode, payoutAccountCode, feesAccountCode }`: turns direct debit on or off and chooses its accounts. Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const gocardless = await withOrganisation(request, body.organisationId, "admin", (tx) => updateGoCardlessSettings(tx, body));
  return json({ gocardless });
});

/** Disconnects (refused while collections are on their way). Admins. */
export const DELETE = route(async (request) => {
  const gocardless = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => disconnectGoCardless(tx));
  return json({ gocardless });
});
