import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { previewCustomReport } from "@/lib/reports/custom";

type Context = { params: Promise<{ reportId: string }> };

/**
 * A draft's figures for an unsaved layout, so the editor shows changes before Save (decision 1360). Saves nothing.
 * `everyAccount: true` (the layout editor, CR23) also lists each group's accounts with nothing in these columns.
 */
export const POST = route<Context>(async (request, context) => {
  const { reportId } = await context.params;
  const body = await readJson(request);
  const figures = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewCustomReport(tx, reportId, body.layout, { everyAccount: body.everyAccount === true }));
  return json({ figures });
});
