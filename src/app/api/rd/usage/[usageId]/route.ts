import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateUsage } from "@/lib/rd/assets";

type Context = { params: Promise<{ usageId: string }> };

/** PATCH: changes a usage log entry (bookkeepers and above); the old version stays in its history (RD23). */
export const PATCH = route<Context>(async (request, context) => {
  const { usageId } = await context.params;
  const body = await readJson(request);
  const asset = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateUsage(tx, usageId, body));
  return json({ asset });
});
