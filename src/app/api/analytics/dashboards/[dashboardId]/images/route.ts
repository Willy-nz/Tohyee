import { json, route, withOrganisation } from "@/lib/api/http";
import { readUploadForm, requireFormFile } from "@/lib/api/upload";
import { getDashboard } from "@/lib/analytics/dashboards";
import { addDashboardImage } from "@/lib/analytics/images";
import { requireAnalytics } from "@/lib/analytics/sources";

type Context = { params: Promise<{ dashboardId: string }> };

/** POST (multipart form): adds an image to a report, for an image item (#376 phase 2; bookkeepers and up, who can change reports). */
export const POST = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const form = await readUploadForm(request);
  const file = await requireFormFile(form);
  const image = await withOrganisation(request, form.get("organisationId"), "bookkeeper", async (tx) => {
    await requireAnalytics(tx);
    const dashboard = await getDashboard(tx, dashboardId);
    return addDashboardImage(tx, dashboard.id, file);
  });
  return json({ image }, { status: 201 });
});
