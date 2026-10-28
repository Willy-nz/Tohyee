import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { getTractorJob } from "@/lib/farming/tractor";
import { exportFileName, jobGeoJson, jobGpx } from "@/lib/farming/tractor-shared";

type Context = { params: Promise<{ jobId: string }> };

/** GET: a job's track and estimated coverage as a file: `format=geojson` or `format=gpx`. Both say the numbers are phone GPS estimates. */
export const GET = route<Context>(async (request, context) => {
  const { jobId } = await context.params;
  const params = searchParams(request);
  const format = params.get("format");
  if (format !== "geojson" && format !== "gpx") throw new ValidationError("Choose GeoJSON or GPX.");
  const job = await withFarmWork(request, params.get("organisationId"), "read", (tx) => getTractorJob(tx, jobId));
  const body = format === "gpx" ? jobGpx(job) : JSON.stringify(jobGeoJson(job), null, 1);
  return new Response(body, {
    headers: {
      "content-type": format === "gpx" ? "application/gpx+xml; charset=utf-8" : "application/geo+json; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFileName(job, format)}"`,
      "cache-control": "no-store",
    },
  });
});
