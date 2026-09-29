import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listBillLinesForAssets } from "@/lib/fixed-assets/service";

/** GET: approved bill lines on an asset type's asset account with cost not yet registered as assets (FA2). */
export const GET = route(async (request) => {
  const lines = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listBillLinesForAssets(tx));
  return json({ lines });
});
