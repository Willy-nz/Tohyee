import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { planMobRound, rotationPlan, setRoundLength } from "@/lib/farming/planning";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's round length and planned moves, with each paddock's and mob's next (BR5-BR6). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const plan = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => rotationPlan(tx, { farmId }));
  return json({ plan });
});

/** PUT `{ roundDays }`: the farm's round length (blank clears it). */
export const PUT = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const plan = await withFarmWork(request, body.organisationId, "record", (tx) => setRoundLength(tx, { farmId, roundDays: body.roundDays }));
  return json({ plan });
});

/** POST `{ mobId, paddockIds, startOn, roundDays, preview }`: plans a mob's round (BR5). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => planMobRound(tx, { farmId, mobId: body.mobId, paddockIds: body.paddockIds, startOn: body.startOn, roundDays: body.roundDays, preview: body.preview }));
  return json(result, { status: result.saved ? 201 : 200 });
});
