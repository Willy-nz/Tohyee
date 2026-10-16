import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { declineProposal } from "@/lib/tax/income/ird-documents";

type Context = { params: Promise<{ proposalId: string }> };

/** POST: a person declines proposed IRD figures, with a reason (owners and admins; ITX33). */
export const POST = route<Context>(async (request, context) => {
  const { proposalId } = await context.params;
  const body = await readJson(request);
  const proposal = await withOrganisation(request, body.organisationId, "admin", (tx) => declineProposal(tx, proposalId, { reason: body.reason }));
  return json({ proposal });
});
