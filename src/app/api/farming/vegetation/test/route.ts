import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { providerCall } from "@/lib/farming/vegetation/http";
import { testOneFarm } from "@/lib/farming/vegetation/jobs";

/**
 * "Test one farm" (decision 1537): one bounded fetch for one farm, showing
 * the bytes, time, memory and processing units it used, and a preview.
 * Owners and admins, at most once a minute.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (tx, { membership }) => ({ organisation: membership.organisation, actor: { ...tx.actor } }));
  const tested = await providerCall(() => testOneFarm(organisation, actor, body.farmId));
  return json(tested);
});
