import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getPlanReport } from "@/lib/farming/fertiliser";

type Context = { params: Promise<{ planId: string }> };

/** GET: the plan's versions, linked bills, applications, and planned against actual. */
export const GET = route<Context>(async (request, context) => {
  const { planId } = await context.params;
  const report = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getPlanReport(tx, planId));
  return json({ report });
});
