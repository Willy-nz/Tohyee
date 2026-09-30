import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { previewStatementRun, queueStatementRun } from "@/lib/email/documents";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { statementFromParams } from "@/lib/email/params";

/** GET ?statementKind=&from=&to=&asAt=: every customer with a balance, and where their statement would go. Bookkeepers and above. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const preview = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) =>
    previewStatementRun(tx, { statement: statementFromParams(params) }),
  );
  return json(preview);
});

/** POST: emails a statement to every customer with a balance and an email address. Idempotent. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => ({
    ...(await queueStatementRun(tx, { statement: body.statement, idempotencyKey: body.idempotencyKey, source: body.source })),
    organisationId: tx.organisationId,
  }));
  if (result.created) kickEmailOutbox(result.organisationId);
  return json({ created: result.created, run: result.run }, { status: result.created ? 201 : 200 });
});
