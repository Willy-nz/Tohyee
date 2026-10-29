import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { aiConnectionFor } from "@/lib/ai/photo-tools";
import { listEstimates } from "@/lib/farming/pasture-photos";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's photo estimates (waiting, then the latest decided), and whether the signed-in person has an AI connected that can propose them. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const result = await withFarmWork(request, params.get("organisationId"), "read", async (tx, { auth, membership }) => ({ ...(await listEstimates(tx, { farmId, limit: params.get("limit") })), ai: await aiConnectionFor(auth, membership) }));
  return json(result);
});
