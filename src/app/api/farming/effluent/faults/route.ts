import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { reportFault } from "@/lib/effluent/care";
import { safetyPeopleMap } from "@/lib/safety/people";

/** POST: reports a fault on a system (`systemId`, `what`, `outOfUse`, `files`): a Safety check with the fault, out of use until released in Safety. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "read", async (tx) => reportFault(tx, body, await safetyPeopleMap(tx.organisationId)));
  return json(result, { status: 201 });
});
