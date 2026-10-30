import { json, readJson, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { refreshGsc } from "@/lib/analytics/search-console";

/** POST: loads Google Search Console now and waits until it's done (Refresh now). Admins and owners. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  return json({ run: await refreshGsc(organisation, actor, "manual") });
});
