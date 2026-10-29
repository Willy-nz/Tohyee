import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addDeferral } from "@/lib/effluent/log";

/** POST: records a day effluent wasn't applied (farm staff and bookkeepers and above, on their farms). Sent from the phone's queue with its operationId. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", (tx) => addDeferral(tx, body));
  return json({ record }, { status: 201 });
});
