import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { connectSimpleFin, disconnectSimpleFin, getSimpleFinStatus, updateSimpleFinSettings } from "@/lib/bank/simplefin/service";

/** Whether this organisation's SimpleFIN Bridge is connected, its accounts and last sync (the access URL is never returned). */
export const GET = route(async (request) => {
  const simplefin = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getSimpleFinStatus(tx));
  return json({ simplefin });
});

/** Connects with a setup token (`setupToken`, `syncEveryHours`). Admins. The token is claimed outside any database transaction. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ simplefin: await connectSimpleFin(organisation, actor, body) }, { status: 201 });
});

/** Changes how often SimpleFIN is synced (`syncEveryHours`). Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const simplefin = await withOrganisation(request, body.organisationId, "admin", (tx) => updateSimpleFinSettings(tx, body));
  return json({ simplefin });
});

/** Disconnects: the access URL is deleted and accounts unlinked. Lines stay. Admins. */
export const DELETE = route(async (request) => {
  const simplefin = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => disconnectSimpleFin(tx, searchParams(request).get("connectionId")));
  return json({ simplefin });
});
