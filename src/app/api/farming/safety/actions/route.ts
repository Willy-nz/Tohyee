import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { safetyPeopleMap } from "@/lib/safety/people";
import { addAction } from "@/lib/safety/reports";

/** Adds a corrective action for a report (`reportId`) or hazard (`hazardId`): `title`, who (`assignedToUserId` or `assignedToName`), `due`. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const action = await withFarmWork(request, body.organisationId, "read", async (tx) => addAction(tx, body, await safetyPeopleMap(tx.organisationId)));
  return json({ action }, { status: 201 });
});
