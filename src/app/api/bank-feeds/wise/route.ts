import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { connectWise, disconnectWise, getWiseStatus, updateWiseSettings } from "@/lib/bank/wise/service";

/** Whether Wise is connected, its balances and last sync (the token is never returned). */
export const GET = route(async (request) => {
  const wise = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getWiseStatus(tx));
  return json({ wise });
});

/** Connects with a business account's personal API `token` (`syncEveryHours`). Admins. It's checked with Wise outside any database transaction. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ wise: await connectWise(organisation, actor, body) }, { status: 201 });
});

/** Changes how often Wise is synced (`syncEveryHours`). Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const wise = await withOrganisation(request, body.organisationId, "admin", (tx) => updateWiseSettings(tx, body));
  return json({ wise });
});

/** Disconnects: the token is deleted and currencies unlinked. Lines stay. Admins. */
export const DELETE = route(async (request) => {
  const wise = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => disconnectWise(tx));
  return json({ wise });
});
