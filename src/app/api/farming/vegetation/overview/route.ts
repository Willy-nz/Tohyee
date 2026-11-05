import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { vegetationOverview } from "@/lib/farming/vegetation/service";

/** GET: every farm the person can see, with its latest clear date (decision 1538). */
export const GET = route(async (request) => {
  const farms = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => vegetationOverview(tx));
  return json({ farms });
});
