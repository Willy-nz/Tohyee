import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getIntercompany, setIntercompany } from "@/lib/consolidation/intercompany";

/** GET: this organisation's intercompany accounts and linked contacts (CO2). Viewers and above. */
export const GET = route(async (request) => {
  const intercompany = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getIntercompany(tx));
  return json({ intercompany });
});

/** PUT `{ accounts: [{ accountId, counterpartOrganisationId }], contacts: [{ contactId, counterpartOrganisationId }] }`: replaces them. Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const intercompany = await withOrganisation(request, body.organisationId, "admin", (tx) => setIntercompany(tx, body));
  return json({ intercompany });
});
