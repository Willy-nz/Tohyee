import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { closeAllPayPalInvoices } from "@/lib/payments/paypal";
import { connectPayPal, disconnectPayPal, getPayPalStatus, updatePayPalSettings } from "@/lib/bank/paypal/service";

/** Whether PayPal is connected, its balances and last sync (the secret is never returned). */
export const GET = route(async (request) => {
  const paypal = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getPayPalStatus(tx));
  return json({ paypal });
});

/** Connects with the live app's `clientId` and `clientSecret` (`syncEveryHours`). Admins. They're checked with PayPal outside any database transaction. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ paypal: await connectPayPal(organisation, actor, body) }, { status: 201 });
});

/** Changes how often PayPal is synced (`syncEveryHours`). Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const paypal = await withOrganisation(request, body.organisationId, "admin", (tx) => updatePayPalSettings(tx, body));
  return json({ paypal });
});

/** Disconnects: the secret is deleted and currencies unlinked. Lines stay. Admins. */
export const DELETE = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const { organisation, actor } = await withOrganisation(request, organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  // PPN9: open PayPal invoices are cancelled before the secret is deleted.
  // Online payments use the first PayPal login (#182): only disconnecting that one switches its payment links off.
  const connectionId = searchParams(request).get("connectionId");
  const status = await withOrganisation(request, organisationId, "admin", (tx) => getPayPalStatus(tx));
  const first = status.connections[0]?.connectionId ?? null;
  const usedForPayments = first !== null && (connectionId === null || connectionId === "" ? status.connections.length === 1 : connectionId === first);
  const links = usedForPayments ? await closeAllPayPalInvoices(organisation, actor, "PayPal disconnected") : { failed: [] as string[] };
  const paypal = await withOrganisation(request, organisationId, "admin", (tx) => disconnectPayPal(tx, connectionId));
  return json({ paypal, linksNotSwitchedOff: links.failed });
});
