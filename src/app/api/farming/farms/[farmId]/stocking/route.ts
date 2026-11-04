import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { farmStocking } from "@/lib/farming/mobs";

type Context = { params: Promise<{ farmId: string }> };

/** GET: stocking rate now, per paddock and for the farm (MOB10). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const stocking = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => farmStocking(tx, { farmId }));
  return json({ stocking });
});
