import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addApplication } from "@/lib/effluent/log";

/** POST: records an irrigation, tanker or spreader run (farm staff and bookkeepers and above, on their farms). Sent from the phone's queue with its operationId. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", (tx) => addApplication(tx, body));
  return json({ record }, { status: 201 });
});
