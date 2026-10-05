import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { billDuplicateWarnings } from "@/lib/bills/duplicates";
import { getApprovalRequest } from "@/lib/approvals/requests";
import { approvalBudget } from "@/lib/approvals/service";

type Context = { params: Promise<{ requestId: string }> };

/**
 * GET: an approval request (AW4, AW9, AW12): its steps and who has approved,
 * whether the signed-in person can act, the budget for the document's
 * accounts, and a bill's likely-duplicate warnings. Viewers and above.
 */
export const GET = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx, { auth, membership }) => {
    const approval = await getApprovalRequest(tx, requestId, { userId: auth.user.id, email: auth.user.email, role: membership.role });
    return {
      request: approval,
      budget: await approvalBudget(tx, requestId),
      warnings: approval.documentType === "bill" && approval.status === "waiting" ? await billDuplicateWarnings(tx, approval.documentId) : [],
    };
  });
  return json(result);
});
