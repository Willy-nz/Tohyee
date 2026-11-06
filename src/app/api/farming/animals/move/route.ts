import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { moveAnimals } from "@/lib/farming/animals";

/** Moves tagged animals to another mob of the same class (AN5): the head goes with them; no livestock movement. Farm work. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => moveAnimals(tx, body));
  return json(result, { status: 201 });
});
