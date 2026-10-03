import { json, readJson, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { reportEmailFolders } from "@/lib/analytics/report-emails";

type Context = { params: Promise<{ organisationId: string }> };
export const GET = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const member = await analyticsMember(request, organisationId, "admin");
  return json({ folders: await reportEmailFolders(member.organisation, member.actor, { accountId: new URL(request.url).searchParams.get("accountId") }) });
});
export const POST = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  const member = await analyticsMember(request, organisationId, "admin");
  return json({ folders: await reportEmailFolders(member.organisation, member.actor, await readJson(request)) });
});
