import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { analyticsMember } from "@/lib/analytics/http";
import { disconnectGsc, dropGscTables, getGscStatus, listGscSites, saveGscSettings, startGscConnect } from "@/lib/analytics/search-console";
import { requestOrigin } from "@/lib/crm/mail/origin";

/** GET: the Search Console connection and its last load (decision 1180). Anyone in the organisation; the Google account only for admins. */
export const GET = route(async (request) => {
  const status = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx, { membership }) =>
    getGscStatus(tx, roleAtLeast(membership.role, "admin")),
  );
  return json(status);
});

/** POST: starts signing in with Google to read Search Console. Admins and owners. Returns Google's sign-in address. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  return json(await withOrganisation(request, body.organisationId, "admin", (tx) => startGscConnect(tx, origin)));
});

/**
 * PATCH: chooses the property and how it loads. Body: { organisationId,
 * siteUrl?, searchType?, reloadDaily? }. A new property is checked against
 * the verified ones Google lists for the account now; a new property or
 * search type drops the loaded tables to start again. Admins and owners.
 */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const available = body.siteUrl === undefined ? null : await listGscSites(organisation, actor);
  const saved = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    saveGscSettings(tx, { siteUrl: body.siteUrl, searchType: body.searchType, reloadDaily: body.reloadDaily }, available),
  );
  if (saved.startAgain) await dropGscTables(organisation.id);
  return json({ connection: saved.connection });
});

/** DELETE: disconnects, deleting the sign-in and the loaded Search Console tables. Admins and owners. */
export const DELETE = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  await disconnectGsc(organisation, actor);
  return json({ ok: true });
});
