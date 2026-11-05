import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { mobAction } from "@/lib/farming/mobs";

type Context = { params: Promise<{ mobId: string }> };

/**
 * One action on a mob (`action`: move, weigh, deaths, births, split, merge,
 * sell, buy, reclass, count; MOB2-MOB9). Farm staff can record field work;
 * sell, buy and reclass need the bookkeeper role (decision 1423, checked in
 * the service). `operationId` lets a phone send it again safely.
 */
export const POST = route<Context>(async (request, context) => {
  const { mobId } = await context.params;
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => mobAction(tx, mobId, body));
  return json(result, { status: 201 });
});
