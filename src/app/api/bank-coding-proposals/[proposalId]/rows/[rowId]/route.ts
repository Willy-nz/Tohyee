import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { editProposalRow } from "@/lib/bank/coding-proposals";

type Context = { params: Promise<{ proposalId: string; rowId: string }> };

/** PATCH: a person's change to an open proposal row (#544, decision 1293): contactId, accountCode, taxCode, description, and the version they saw. */
export const PATCH = route<Context>(async (request, context) => {
  const { proposalId, rowId } = await context.params;
  const body = await readJson(request);
  const row = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => editProposalRow(tx, proposalId, rowId, body));
  return json({ row });
});
