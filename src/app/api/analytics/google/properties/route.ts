import { json, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listGaProperties } from "@/lib/analytics/google-analytics";

/** GET: the GA4 properties the connected Google account can see, to choose one (GA2). Admins and owners. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  return json({ properties: await listGaProperties(organisation, actor) });
});
