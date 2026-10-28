import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { listTractorJobs, MAX_JOB_BYTES, saveTractorJob } from "@/lib/farming/tractor";

/** GET: a farm's tractor jobs, newest first (`farmId`, `limit`, `before`). Farm staff see their own. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const jobs = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listTractorJobs(tx, { farmId: params.get("farmId"), limit: params.get("limit"), before: params.get("before") }));
  return json({ jobs });
});

/**
 * Saves a finished job from the phone: `id` (made by the phone), `farmId`,
 * `paddockIds`, `operation`, `equipmentId`, `track`, and optional notes,
 * declared product, rate and quantity, and links. Sending the same job again
 * returns it with status 200 instead of 201.
 */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_JOB_BYTES });
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => saveTractorJob(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
