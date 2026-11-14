import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listAiActionRequests } from "@/lib/ai/action-approvals";

/** GET: what the AI has asked a person to approve (#697): waiting, then the last 20 decided. Bookkeepers and up, who can approve. */
export const GET = route(async (request) => {
  const requests = await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => listAiActionRequests(tx));
  return json(requests);
});
