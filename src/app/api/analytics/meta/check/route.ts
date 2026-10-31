import { json, route, searchParams } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { checkMetaSetup } from "@/lib/analytics/meta";

/** GET: Check setup (META8): each part of the Meta setup, and plainly what to fix. Asks Meta, changes nothing. Admins and owners. */
export const GET = route(async (request) => {
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "admin");
  return json({ checks: await checkMetaSetup(organisation, actor) });
});
