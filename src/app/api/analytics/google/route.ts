import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { analyticsMember } from "@/lib/analytics/http";
import { disconnectGa, dropGaTables, getGaStatus, listGaProperties, saveGaSettings, startGaConnect } from "@/lib/analytics/google-analytics";
import { requestOrigin } from "@/lib/crm/mail/origin";

/** GET: the Google Analytics connection and its last load (decision 606). Anyone in the organisation; the Google account only for admins. */
export const GET = route(async (request) => {
  const status = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx, { membership }) =>
    getGaStatus(tx, roleAtLeast(membership.role, "admin")),
  );
  return json(status);
});

/** POST: starts signing in with Google. Admins and owners. Returns Google's sign-in address. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  return json(await withOrganisation(request, body.organisationId, "admin", (tx) => startGaConnect(tx, origin)));
});

/**
 * PATCH: chooses the property and how it loads. Body: { organisationId,
 * propertyId?, historyMonths?, reloadDaily? }. A new property is checked
 * against what Google lists for the account now; the old property's
 * tables are dropped. Admins and owners.
 */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const available = body.propertyId === undefined ? null : await listGaProperties(organisation, actor);
  const saved = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    saveGaSettings(tx, { propertyId: body.propertyId, historyMonths: body.historyMonths, reloadDaily: body.reloadDaily }, available),
  );
  if (saved.propertyChanged) await dropGaTables(organisation.id);
  return json({ connection: saved.connection });
});

/** DELETE: disconnects, deleting the sign-in and the loaded Google Analytics tables. Admins and owners. */
export const DELETE = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  await disconnectGa(organisation, actor);
  return json({ ok: true });
});
