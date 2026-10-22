import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { previewShapedTable, shapeColumnsAt } from "@/lib/analytics/shaped-tables";
import { requireAnalytics } from "@/lib/analytics/sources";
import { getOrganisationSettings } from "@/lib/organisations/settings";

/**
 * Runs the steps (through `throughStep`) and returns the first 100 rows and
 * the rows after each step. With `columnsOnly`, nothing is run: it returns
 * the columns after `throughStep` (-1 for the base table), for a step's settings.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation } = await analyticsMember(request, body.organisationId, "admin");
  const yearEndMonth = await withOrganisation(request, organisation.id, "admin", async (tx) => {
    await requireAnalytics(tx);
    return (await getOrganisationSettings(tx)).financialYearEndMonth;
  });
  const baseTable = String(body.baseTable ?? "");
  if (body.columnsOnly === true) {
    return json({ columns: await shapeColumnsAt(organisation.id, baseTable, body.steps, Number(body.throughStep ?? -1)) });
  }
  const preview = await previewShapedTable(organisation.id, baseTable, body.steps, body.throughStep as number | undefined, yearEndMonth);
  return json(preview);
});
