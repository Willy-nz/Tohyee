import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listProposals } from "@/lib/bank/coding-proposals";

/** GET: the newest bank coding proposals (#544), optionally for one bank account (`accountId`), with their counts by state. */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const proposals = await withOrganisation(request, query.get("organisationId"), "viewer", (tx) => listProposals(tx, { accountId: query.get("accountId") }));
  return json({ proposals });
});
