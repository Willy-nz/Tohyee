import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { rejectProposalRows } from "@/lib/bank/coding-proposals";

type Context = { params: Promise<{ proposalId: string }> };

/** POST: rejects open rows (#544): `rows` [{id, version}] and an optional `reason`. Nothing is posted. */
export const POST = route<Context>(async (request, context) => {
  const { proposalId } = await context.params;
  const body = await readJson(request);
  const proposal = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => rejectProposalRows(tx, proposalId, { rows: body.rows, reason: body.reason }));
  return json({ proposal });
});
