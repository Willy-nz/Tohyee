import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { recordBcs } from "@/lib/farming/bcs";

/** Records a BCS for an animal (`animalId`, `score`) or a mob (`mobId`, `tally` or `average` and `headScored`), with `files` (photos). Farm work, also from the phone's queue. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => recordBcs(tx, body));
  return json(result, { status: 201 });
});
