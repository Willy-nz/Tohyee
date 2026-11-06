import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addPhotosToScore } from "@/lib/farming/bcs";

/** Keeps photos of an animal or mob to score later (`animalId` or `mobId`, `files` from the farm photo store, `onDate`). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => addPhotosToScore(tx, body));
  return json(result, { status: 201 });
});
