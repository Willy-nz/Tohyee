import { json, readJson, requireAuth, route, searchParams } from "@/lib/api/http";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { createFarmAppKey, listFarmAppKeys, MAX_ACTIVE_FARM_APP_KEYS } from "@/lib/farm-apps/keys";
import { scopesAllowed } from "@/lib/farm-apps/scopes";
import { parseOrganisationId } from "@/lib/organisations/registry";

/** GET: the signed-in person's own farm app keys (never the keys), the most they can have, and the scopes their role allows (FA1, FA2). */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId(searchParams(request).get("organisationId"));
  const membership = await requireOrganisationRole(auth, organisationId, "viewer");
  return json({ keys: await listFarmAppKeys(auth, organisationId), maxActiveKeys: MAX_ACTIVE_FARM_APP_KEYS, scopesAllowed: scopesAllowed(membership.role) });
});

/** POST { organisationId, name, scopes }: makes a key; it's in this answer only. Recording scopes need the bookkeeper role or higher. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const organisationId = parseOrganisationId(body.organisationId);
  const membership = await requireOrganisationRole(auth, organisationId, "viewer");
  return json(await createFarmAppKey(auth, organisationId, { name: body.name, scopes: body.scopes, role: membership.role }), { status: 201 });
});
