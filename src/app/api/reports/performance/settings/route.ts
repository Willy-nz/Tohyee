import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getPerformanceSettings, savePerformanceSettings, suggestedCount } from "@/lib/reports/performance-report";

/** The year-end report format and the entity information (NPR10), with how many used accounts are still on a suggested category. */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => ({
    settings: await getPerformanceSettings(tx),
    suggestedAccounts: await suggestedCount(tx),
  }));
  return json(result);
});

/** Saves the format (`special_purpose`, `tier3`, `tier4`) and/or the entity information. Bookkeepers. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => savePerformanceSettings(tx, { format: body.format, entity: body.entity }));
  return json({ settings });
});
