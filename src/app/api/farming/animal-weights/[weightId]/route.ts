import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { removeAnimalWeight } from "@/lib/farming/animals";

type Context = { params: Promise<{ weightId: string }> };

/** PATCH `{ removed: true, reason }`: removes a weight typed wrongly (kept, marked removed). Bookkeepers and up. */
export const PATCH = route<Context>(async (request, context) => {
  const { weightId } = await context.params;
  const body = await readJson(request);
  await withFarmWork(request, body.organisationId, "record", (tx) => removeAnimalWeight(tx, weightId, { reason: body.reason }));
  return json({ removed: true });
});
