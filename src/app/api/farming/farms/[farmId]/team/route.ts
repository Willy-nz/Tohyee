import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { farmTeam } from "@/lib/farming/tasks";
import { requireFarmAccess } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { requireId } from "@/lib/validation";

type Context = { params: Promise<{ farmId: string }> };

/** GET: who a task on this farm can be for: members who record farm work and can see the farm (names and roles only). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const people = await withFarmWork(request, searchParams(request).get("organisationId"), "read", async (tx) => {
    await requireFarming(tx);
    const id = requireId(farmId, "farmId");
    await requireFarmAccess(tx, id);
    return farmTeam(tx, id);
  });
  return json({ people });
});
