import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { changeReport } from "@/lib/safety/reports";

type Context = { params: Promise<{ recordId: string }> };

/** A new version of a report: `step` is update, correct, withdraw, worksafe or close, with `expectedVersion`. */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const report = await withOrganisation(request, body.organisationId, "viewer", (tx) => changeReport(tx, recordId, body));
  return json({ report });
});
