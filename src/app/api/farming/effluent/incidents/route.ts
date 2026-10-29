import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addIncident } from "@/lib/effluent/care";
import { safetyPeopleMap } from "@/lib/safety/people";

/** POST: records an effluent incident, with its first actions. Never tells the council: that's for a person. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "read", async (tx) => addIncident(tx, body, await safetyPeopleMap(tx.organisationId)));
  return json(result, { status: 201 });
});
