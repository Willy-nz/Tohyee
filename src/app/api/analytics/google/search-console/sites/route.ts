import { json, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listGscSites } from "@/lib/analytics/search-console";

/** GET: the verified Search Console properties the connected Google account can read, to choose one (GSC2). Admins and owners. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  return json({ sites: await listGscSites(organisation, actor) });
});
