import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeUsage } from "@/lib/rd/assets";

type Context = { params: Promise<{ usageId: string }> };

/** POST: removes a usage log entry with a reason (bookkeepers and above). It's kept in history. */
export const POST = route<Context>(async (request, context) => {
  const { usageId } = await context.params;
  const body = await readJson(request);
  const asset = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => removeUsage(tx, usageId, body.reason));
  return json({ asset });
});
