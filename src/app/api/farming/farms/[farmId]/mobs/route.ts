import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { createMob, listMobs } from "@/lib/farming/mobs";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's mobs (`includeClosed=1` for closed ones too). Farm staff too (decision 1423). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const mobs = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listMobs(tx, { farmId, includeClosed: params.get("includeClosed") }));
  return json({ mobs });
});

/** Adds a mob (MOB1). Bought stock needs the bookkeeper role (checked in the service). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => createMob(tx, { ...body, farmId }));
  return json(result, { status: 201 });
});
