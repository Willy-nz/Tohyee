import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { listReportEmails, saveReportMailbox } from "@/lib/analytics/report-emails";

type Context = { params: Promise<{ organisationId: string }> };
export const GET = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  return json(await withOrganisation(request, organisationId, "admin", listReportEmails));
});
export const POST = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const input = await readJson(request);
  return json(await withOrganisation(request, organisationId, "admin", (tx) => saveReportMailbox(tx, input)));
});
