import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { saveReportDetails } from "@/lib/safety/reports";

type Context = { params: Promise<{ recordId: string }> };

/** Adds or changes a report's restricted details (who was hurt, injury, treatment). */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const details = await withOrganisation(request, body.organisationId, "viewer", (tx) => saveReportDetails(tx, recordId, body));
  return json({ details });
});
