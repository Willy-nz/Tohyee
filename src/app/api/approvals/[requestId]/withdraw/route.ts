import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { withdrawApprovalRequest } from "@/lib/approvals/service";

type Context = { params: Promise<{ requestId: string }> };

/** POST: withdraws a waiting document from approval (AW8): an ordinary draft again. Its submitter or an admin; a claim, its claimant. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { auth, membership }) =>
    withdrawApprovalRequest(tx, { userId: auth.user.id, email: auth.user.email, role: membership.role }, requestId),
  );
  return json({ request: result });
});
