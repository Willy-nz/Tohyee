import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { deleteRule } from "@/lib/private-mail/filing";

type Context = { params: Promise<{ ruleId: string }> };

/** DELETE ?organisationId=: deletes a filing rule and what's waiting from it; what was filed stays (PM26). */
export const DELETE = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx) => deleteRule(tx, await MailOwner.of(tx), ruleId));
  return json({ deleted: true });
});
