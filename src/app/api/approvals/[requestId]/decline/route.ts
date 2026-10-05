import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { declineApprovalStep } from "@/lib/approvals/service";

type Context = { params: Promise<{ requestId: string }> };

/** POST `{ reason }`: declines the current step (AW7): the document goes back to draft with the reason. People only. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { auth, membership }) =>
    declineApprovalStep(tx, { userId: auth.user.id, email: auth.user.email, role: membership.role }, requestId, { reason: body.reason }),
  );
  return json({ request: result });
});
