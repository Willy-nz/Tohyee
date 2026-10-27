import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { recordCheck } from "@/lib/safety/equipment";
import { safetyPeopleMap } from "@/lib/safety/people";

/** Records a pre-start check (`equipmentId`, `checklistVersion`, `answers`: key, result ok/fault/na, note). A critical fault puts the equipment out of use. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "read", async (tx) => recordCheck(tx, body, await safetyPeopleMap(tx.organisationId)));
  return json(result, { status: 201 });
});
