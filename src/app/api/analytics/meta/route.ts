import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { analyticsMember } from "@/lib/analytics/http";
import { availableMetaAccounts, disconnectMeta, dropMetaTables, getMetaStatus, saveMetaChoice, startMetaConnect } from "@/lib/analytics/meta";
import { requestOrigin } from "@/lib/crm/mail/origin";

/** GET: whether the Meta app is saved, the connection and its last load (decision 1190). Anyone in the organisation; the Facebook name only for admins. */
export const GET = route(async (request) => {
  const status = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx, { membership }) =>
    getMetaStatus(tx, roleAtLeast(membership.role, "admin")),
  );
  return json(status);
});

/** POST: starts signing in with Facebook. Body: { organisationId, withAds? }. Admins and owners. Returns Meta's sign-in address. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  return json(await withOrganisation(request, body.organisationId, "admin", (tx) => startMetaConnect(tx, origin, { withAds: body.withAds })));
});

/**
 * PATCH: chooses the Page (and so its Instagram account), the ad account
 * (null for none) and nightly loading. Body: { organisationId, pageId?,
 * adAccountId?, reloadDaily? }. Checked against what Meta lists for the
 * sign-in now; a different Page or ad account drops that part's tables.
 * Admins and owners.
 */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const available = body.pageId === undefined && (body.adAccountId === undefined || body.adAccountId === null || body.adAccountId === "") ? null : await availableMetaAccounts(organisation, actor);
  const saved = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    saveMetaChoice(tx, { pageId: body.pageId, adAccountId: body.adAccountId, reloadDaily: body.reloadDaily }, available),
  );
  if (saved.startAgain.length) await dropMetaTables(organisation.id, saved.startAgain);
  return json({ connection: saved.connection });
});

/** DELETE: disconnects, deleting the sign-in and the loaded Meta tables. The saved app stays. Admins and owners. */
export const DELETE = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  await disconnectMeta(organisation, actor);
  return json({ ok: true });
});
