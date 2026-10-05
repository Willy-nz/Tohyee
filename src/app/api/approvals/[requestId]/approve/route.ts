import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { publicOrigin } from "@/lib/auth/origin";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { ConflictError } from "@/lib/errors";
import { approveApprovalStep } from "@/lib/approvals/service";

type Context = { params: Promise<{ requestId: string }> };

/**
 * POST: approves the current step as the signed-in person (AW5). At the last
 * step the document is approved (a claim on `claimDate`; a bill despite a
 * likely duplicate with `approveDespiteWarnings`). If that approval is
 * refused (a locked period, AW10) the request keeps the reason and the
 * response is 409. People only: the connected AI can't approve (question 6).
 */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const origin = await publicOrigin(request);
  const { result, organisationId } = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { auth, membership }) => ({
    result: await approveApprovalStep(tx, { userId: auth.user.id, email: auth.user.email, role: membership.role }, requestId, {
      claimDate: body.claimDate,
      approveDespiteWarnings: body.approveDespiteWarnings,
      origin,
    }),
    organisationId: membership.organisation.id,
  }));
  kickEmailOutbox(organisationId);
  // The reason is saved with the request; the refusal is reported after that's committed.
  if (result.refused) throw new ConflictError(result.refused);
  return json({ request: result.request });
});
