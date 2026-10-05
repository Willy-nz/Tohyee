import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { moveApprovalRule } from "@/lib/approvals/rules";

type Context = { params: Promise<{ ruleId: string }> };

/** POST `{ direction: "up" | "down" }`: moves a rule in the order rules are tried (AW11). Admins. */
export const POST = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  const body = await readJson(request);
  const rules = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) => moveApprovalRule(tx, membership.role, ruleId, body.direction));
  return json({ rules });
});
