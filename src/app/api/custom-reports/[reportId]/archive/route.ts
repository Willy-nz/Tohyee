import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { setCustomReportArchived } from "@/lib/reports/custom";

type Context = { params: Promise<{ reportId: string }> };

/** Archives a report (`archived: true`) or brings it back (`archived: false`). */
export const POST = route<Context>(async (request, context) => {
  const { reportId } = await context.params;
  const body = await readJson(request);
  if (typeof body.archived !== "boolean") throw new ValidationError("archived must be true or false.");
  const archived = body.archived;
  const report = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setCustomReportArchived(tx, reportId, archived));
  return json({ report });
});
