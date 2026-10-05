import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { setBudgetRate } from "@/lib/consolidation/groups";

type Context = { params: Promise<{ groupId: string }> };

/** PUT `{ currencyCode, month, rate }`: a month's budget exchange rate (CO11); blank removes it. Admins of every organisation. */
export const PUT = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ budgetRates: await setBudgetRate({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) });
});
