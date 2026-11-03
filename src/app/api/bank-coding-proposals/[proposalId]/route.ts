import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getProposal } from "@/lib/bank/coding-proposals";

type Context = { params: Promise<{ proposalId: string }> };

/** GET: one bank coding proposal (#544) with its rows (`filter`: a state, or "attention"), totals and each open row's problems. */
export const GET = route<Context>(async (request, context) => {
  const { proposalId } = await context.params;
  const query = searchParams(request);
  const proposal = await withOrganisation(request, query.get("organisationId"), "viewer", (tx) => getProposal(tx, proposalId, { filter: query.get("filter") }));
  return json({ proposal });
});
