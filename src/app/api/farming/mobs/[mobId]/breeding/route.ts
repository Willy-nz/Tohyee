import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { listBreeding, recordBreeding } from "@/lib/farming/planning";

type Context = { params: Promise<{ mobId: string }> };

/** GET: the mob's mating, AI, scanning and pregnancy test records (BR1-BR4). */
export const GET = route<Context>(async (request, context) => {
  const { mobId } = await context.params;
  const breeding = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => listBreeding(tx, { mobId }));
  return json({ breeding });
});

/** POST: records mating, AI, scanning or a pregnancy test (`recordType`). Farm staff too. */
export const POST = route<Context>(async (request, context) => {
  const { mobId } = await context.params;
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "record", (tx) => recordBreeding(tx, mobId, body));
  return json({ record }, { status: 201 });
});
