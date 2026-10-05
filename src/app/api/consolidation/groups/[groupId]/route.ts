import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { listAdjustments, listBudgetRates, listRateOverrides, requireGroup, updateGroup } from "@/lib/consolidation/groups";

type Context = { params: Promise<{ groupId: string }> };

/** GET: a group with its elimination adjustments, changed rates and budget rates. */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  const group = await requireGroup({ id: auth.user.id, email: auth.user.email }, groupId);
  return json({ group, adjustments: await listAdjustments(group.id), rateOverrides: await listRateOverrides(group.id), budgetRates: await listBudgetRates(group.id) });
});

/** PUT `{ name, organisationIds, version }`: changes the name and members. Admins of every organisation. */
export const PUT = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ group: await updateGroup({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) });
});
