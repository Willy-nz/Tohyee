import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { getSprayWithholding, setSprayWithholding } from "@/lib/farming/treatments";

type Context = { params: Promise<{ jobId: string }> };

/** GET: a spray job's grazing withholding (null when none is set). */
export const GET = route<Context>(async (request, context) => {
  const { jobId } = await context.params;
  const withholding = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => getSprayWithholding(tx, jobId));
  return json({ withholding });
});

/** PUT `{ days, note }`: the label's grazing withholding for this spray job's paddocks (TRT5); blank days removes it. */
export const PUT = route<Context>(async (request, context) => {
  const { jobId } = await context.params;
  const body = await readJson(request);
  const withholding = await withFarmWork(request, body.organisationId, "record", (tx) => setSprayWithholding(tx, jobId, { days: body.days, note: body.note }));
  return json({ withholding });
});
