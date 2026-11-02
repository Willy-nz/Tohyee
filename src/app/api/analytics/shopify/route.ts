import { json, readJson, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { refreshShopify } from "@/lib/analytics/shopify";

/** Copies Tohyee's Shopify data into the organisation's analytics now (decision 1244). Never calls Shopify. Admins and owners. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  return json({ run: await refreshShopify(organisation, actor, "manual") });
});
