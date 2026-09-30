import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listDocumentEmails, queueDocumentEmail } from "@/lib/email/documents";
import { kickEmailOutbox } from "@/lib/email/outbox";

/** GET ?kind=&id=: the emails sent (or being sent) about a document, or to a customer for statements. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const emails = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listDocumentEmails(tx, params.get("kind"), params.get("id")));
  return json({ emails });
});

/**
 * POST: queues an email with the document's PDF attached (bookkeepers and
 * above); the background job sends it straight away and records the result
 * in the document's history. Idempotent.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => ({
    ...(await queueDocumentEmail(tx, {
      kind: body.kind,
      id: body.id,
      statement: body.statement,
      to: body.to,
      cc: body.cc,
      subject: body.subject,
      body: body.body,
      idempotencyKey: body.idempotencyKey,
      source: body.source,
    })),
    organisationId: tx.organisationId,
  }));
  if (result.created) kickEmailOutbox(result.organisationId);
  return json({ created: result.created, email: result.email }, { status: result.created ? 201 : 200 });
});
