import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listSigningRequests, signingEmailReadiness } from "@/lib/signing/service";

/** GET: signing requests the person may see (`sourceKind`, `sourceId`, `state` to filter), and whether signing emails can be sent. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "farm_worker", async (tx) => ({
    requests: await listSigningRequests(tx, { sourceKind: params.get("sourceKind"), sourceId: params.get("sourceId"), state: params.get("state") }),
    email: await signingEmailReadiness(tx),
  }));
  return json(result);
});
