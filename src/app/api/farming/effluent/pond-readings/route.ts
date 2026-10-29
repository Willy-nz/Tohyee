import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addPondReading } from "@/lib/effluent/log";

/** POST: records a pond or sump reading (farm staff and bookkeepers and above, on their farms). Sent from the phone's queue with its operationId. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", (tx) => addPondReading(tx, body));
  return json({ record }, { status: 201 });
});
