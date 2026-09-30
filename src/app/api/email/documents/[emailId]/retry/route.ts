import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { retryDocumentEmail } from "@/lib/email/documents";
import { kickEmailOutbox } from "@/lib/email/outbox";

type Context = { params: Promise<{ emailId: string }> };

/** POST: sends a failed email again, as it was (a new email in the history). Bookkeepers and above. Idempotent. */
export const POST = route<Context>(async (request, context) => {
  const { emailId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => ({
    ...(await retryDocumentEmail(tx, emailId, { idempotencyKey: body.idempotencyKey, source: body.source })),
    organisationId: tx.organisationId,
  }));
  if (result.created) kickEmailOutbox(result.organisationId);
  return json({ created: result.created, email: result.email }, { status: result.created ? 201 : 200 });
});
