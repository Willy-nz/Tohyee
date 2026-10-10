import { assertSameOrigin } from "@/lib/auth/guard";
import { json, readJson, route, withCrm } from "@/lib/api/http";
import { sendSalesEmail } from "@/lib/crm/sales-email";

/**
 * Sends one email from your own connected mailbox (decision 496):
 * `accountId`, `leadId` or `personId` or `opportunityId`, `subject`, `body`,
 * `idempotencyKey`, and optionally the `templateId` it started from. A retry
 * with the same key returns what happened instead of sending again.
 */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = await sendSalesEmail((work) => withCrm(request, body.organisationId, "write", (tx, { scope }) => work(tx, scope)), {
    source: body.source,
    idempotencyKey: body.idempotencyKey,
    accountId: body.accountId,
    templateId: body.templateId,
    leadId: body.leadId,
    personId: body.personId,
    opportunityId: body.opportunityId,
    subject: body.subject,
    body: body.body,
  });
  return json({ email }, { status: email.status === "sent" ? 201 : 200 });
});
