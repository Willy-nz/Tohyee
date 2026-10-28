import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeApplication } from "@/lib/effluent/log";

/**
 * POST: a new version of a run with the run's id in the body (`recordId`),
 * for the phone's queue: a shift or stop recorded with no signal, for a
 * run that was itself started with no signal, gets the run's id from the
 * first item's answer once that's sent (decision 1082).
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", (tx) => changeApplication(tx, body.recordId, body));
  return json({ record });
});
