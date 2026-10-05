import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setApprovalRuleArchived } from "@/lib/approvals/rules";
import { ValidationError } from "@/lib/errors";

type Context = { params: Promise<{ ruleId: string }> };

/** POST `{ archived }`: archives a rule (rules are never deleted) or restores it at the end of the list. Admins. */
export const POST = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  const body = await readJson(request);
  if (typeof body.archived !== "boolean") throw new ValidationError("archived must be true or false.");
  const rule = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) => setApprovalRuleArchived(tx, membership.role, ruleId, body.archived as boolean));
  return json({ rule });
});
