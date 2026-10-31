import { json, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listMetaAccounts } from "@/lib/analytics/meta";

/** GET: the Pages (with linked Instagram accounts) and ad accounts the signed-in Facebook account can see, to choose (META2). Admins and owners. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  return json(await listMetaAccounts(organisation, actor));
});
