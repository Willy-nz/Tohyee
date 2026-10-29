import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { getTractorJob } from "@/lib/farming/tractor";
import { exportFileName, jobGeoJson, jobGpx, jobSummaryText } from "@/lib/farming/tractor-shared";

type Context = { params: Promise<{ jobId: string }> };

/**
 * GET: a job as a file: `format=geojson` or `format=gpx` (the track and
 * estimated coverage) or `format=summary` (plain text). Each says the numbers
 * are phone GPS estimates, what it covers, and every version of the job's
 * details with its corrections (#491).
 */
export const GET = route<Context>(async (request, context) => {
  const { jobId } = await context.params;
  const params = searchParams(request);
  const format = params.get("format");
  if (format !== "geojson" && format !== "gpx" && format !== "summary") throw new ValidationError("Choose GeoJSON, GPX or a summary.");
  const job = await withFarmWork(request, params.get("organisationId"), "read", (tx) => getTractorJob(tx, jobId));
  const body = format === "gpx" ? jobGpx(job) : format === "summary" ? jobSummaryText(job) : JSON.stringify(jobGeoJson(job), null, 1);
  return new Response(body, {
    headers: {
      "content-type": format === "gpx" ? "application/gpx+xml; charset=utf-8" : format === "summary" ? "text/plain; charset=utf-8" : "application/geo+json; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFileName(job, format === "summary" ? "txt" : format)}"`,
      "cache-control": "no-store",
    },
  });
});
