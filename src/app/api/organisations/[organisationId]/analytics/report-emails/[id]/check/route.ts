import { json, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { checkReportMailbox } from "@/lib/analytics/report-emails";

type Context = { params: Promise<{ organisationId: string; id: string }> };
export const POST = route<Context>(async (request, context) => {
  const { organisationId, id } = await context.params;
  const member = await analyticsMember(request, organisationId, "admin");
  return json({ check: await checkReportMailbox(member.organisation, member.actor, id) });
});
