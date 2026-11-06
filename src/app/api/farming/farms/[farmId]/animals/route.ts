import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { createAnimal, listAnimals } from "@/lib/farming/animals";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's animals (`includeGone=1` for sold and dead too; `mobId`, `q` to filter). Farm staff too (decision 1481). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const animals = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listAnimals(tx, { farmId, includeGone: params.get("includeGone"), mobId: params.get("mobId"), q: params.get("q") }));
  return json({ animals });
});

/** Adds an animal (AN1), tagged into its mob if one is chosen (AN2: no head changes). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const animal = await withFarmWork(request, body.organisationId, "record", (tx) => createAnimal(tx, { ...body, farmId }));
  return json({ animal }, { status: 201 });
});
