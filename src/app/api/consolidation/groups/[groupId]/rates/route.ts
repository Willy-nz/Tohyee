import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { setRateOverride } from "@/lib/consolidation/groups";

type Context = { params: Promise<{ groupId: string }> };

/** PUT `{ currencyCode, month, kind, rate, reason }`: changes a month's consolidation rate; a blank rate goes back to the worked-out one. Admins of every organisation. */
export const PUT = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ rateOverrides: await setRateOverride({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) });
});
