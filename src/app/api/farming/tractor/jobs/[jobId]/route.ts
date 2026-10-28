import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { changeTractorJob, getTractorJob } from "@/lib/farming/tractor";

type Context = { params: Promise<{ jobId: string }> };

/** GET: one tractor job with its track and coverage. */
export const GET = route<Context>(async (request, context) => {
  const { jobId } = await context.params;
  const job = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => getTractorJob(tx, jobId));
  return json({ job });
});

/** Changes a job's paddocks, notes, declared values or links, or withdraws it (`withdraw`: why). The track never changes. */
export const PATCH = route<Context>(async (request, context) => {
  const { jobId } = await context.params;
  const body = await readJson(request);
  const job = await withFarmWork(request, body.organisationId, "record", (tx) => changeTractorJob(tx, jobId, body));
  return json({ job });
});
