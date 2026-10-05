import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getApprovalRule, updateApprovalRule } from "@/lib/approvals/rules";

type Context = { params: Promise<{ ruleId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  const rule = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getApprovalRule(tx, ruleId));
  return json({ rule });
});

/** PUT: changes a rule's name, conditions and steps; `version` is the one read. Admins. A waiting document follows the rule as it is now (AW6). */
export const PUT = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) => updateApprovalRule(tx, membership.role, ruleId, body));
  return json(result);
});
