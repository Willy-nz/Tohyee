import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { getEcbSettings, refreshEcbRates } from "@/lib/fx/ecb";

/** POST: reads the ECB's rates now and adds any new ones. Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await refreshEcbRates(organisation, actor);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => getEcbSettings(tx));
  return json({ added: result.added, error: result.error, settings });
});
