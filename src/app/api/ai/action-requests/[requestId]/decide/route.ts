import { json, readJson, route } from "@/lib/api/http";
import { approveAiAction } from "@/lib/ai/action-approval-run";
import { declineAiAction } from "@/lib/ai/action-approvals";
import { analyticsMember } from "@/lib/analytics/http";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";

type Context = { params: Promise<{ requestId: string }> };

/**
 * POST { organisationId, decision: "approve" | "decline" }: a person decides
 * something the AI asked to void, delete or roll back (#697). Approving does
 * it now, as this person, with the tool's own checks. Bookkeepers and up; a
 * tool that needs an owner or admin on its screen needs one here.
 */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor, role } = await analyticsMember(request, body.organisationId, "bookkeeper");
  if (body.decision === "decline") {
    return json({ request: await withOrganisationTransaction(organisation, actor, (tx) => declineAiAction(tx, requestId, role)) });
  }
  if (body.decision !== "approve") throw new ValidationError("decision is approve or decline.");
  return json({ request: await approveAiAction(organisation, { ...actor, role }, requestId) });
});
