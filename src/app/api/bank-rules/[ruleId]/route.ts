import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteBankRule, updateBankRule } from "@/lib/bank/rules";

type Context = { params: Promise<{ ruleId: string }> };

export const PATCH = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  const body = await readJson(request);
  const rule = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateBankRule(tx, ruleId, body));
  return json({ rule });
});

export const DELETE = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteBankRule(tx, ruleId));
  return json({ deleted: true });
});
