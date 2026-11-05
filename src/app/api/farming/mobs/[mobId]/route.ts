import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { getMob, updateMob } from "@/lib/farming/mobs";

type Context = { params: Promise<{ mobId: string }> };

/** GET: a mob, its events (newest first) and its weights with the gain between each. */
export const GET = route<Context>(async (request, context) => {
  const { mobId } = await context.params;
  const result = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => getMob(tx, mobId));
  return json(result);
});

/** PATCH: rename a mob or change its tag colour. */
export const PATCH = route<Context>(async (request, context) => {
  const { mobId } = await context.params;
  const body = await readJson(request);
  const mob = await withFarmWork(request, body.organisationId, "record", (tx) => updateMob(tx, mobId, { name: body.name, tagColour: body.tagColour }));
  return json({ mob });
});
