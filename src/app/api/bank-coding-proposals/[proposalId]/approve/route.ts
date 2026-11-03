import { json, readJson, route, withOrganisationRunner } from "@/lib/api/http";
import { approveProposalRows } from "@/lib/bank/coding-proposals";

type Context = { params: Promise<{ proposalId: string }> };

/**
 * POST: approves open rows (#544, decision 1294): `rows` [{id, version}] and
 * an `idempotencyKey`. Rows that no longer hold are left as they are
 * (`skipped`, with why); the rest are posted as a durable batch, each
 * checked again first. The same key again resumes the same batch.
 */
export const POST = route<Context>(async (request, context) => {
  const { proposalId } = await context.params;
  const body = await readJson(request);
  const outcome = await withOrganisationRunner(request, body.organisationId, "bookkeeper", (run) =>
    approveProposalRows(run, proposalId, { rows: body.rows, idempotencyKey: body.idempotencyKey, source: "ui" }),
  );
  return json(outcome, { status: outcome.created ? 201 : 200, ...(outcome.retryAfterSeconds ? { headers: { "retry-after": String(outcome.retryAfterSeconds) } } : {}) });
});
