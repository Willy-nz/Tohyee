import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { acceptProposal } from "@/lib/tax/income/ird-documents";

type Context = { params: Promise<{ proposalId: string }> };

/** POST: a person accepts proposed IRD figures (owners and admins; ITX33). */
export const POST = route<Context>(async (request, context) => {
  const { proposalId } = await context.params;
  const body = await readJson(request);
  const proposal = await withOrganisation(request, body.organisationId, "admin", (tx) => acceptProposal(tx, proposalId));
  return json({ proposal });
});
