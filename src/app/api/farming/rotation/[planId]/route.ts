import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { cancelPlannedMove } from "@/lib/farming/planning";

type Context = { params: Promise<{ planId: string }> };

/** Cancels a planned move (kept, marked cancelled). */
export const DELETE = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  await withFarmWork(request, searchParams(request).get("organisationId"), "record", (tx) => cancelPlannedMove(tx, planId));
  return json({ ok: true });
});
