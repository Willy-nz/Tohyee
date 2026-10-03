import { json, route, withOrganisation } from "@/lib/api/http";
import { deleteReportMailbox } from "@/lib/analytics/report-emails";

type Context = { params: Promise<{ organisationId: string; id: string }> };
export const DELETE = route<Context>(async (request, context) => {
  const { organisationId, id } = await context.params;
  await withOrganisation(request, organisationId, "admin", (tx) => deleteReportMailbox(tx, id));
  return json({ deleted: true });
});
