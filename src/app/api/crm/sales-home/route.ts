import { json, route, searchParams, withCrm } from "@/lib/api/http";
import { salesHome } from "@/lib/crm/sales-home";

/**
 * GET ?organisationId=: the CRM Home's sales cards (decision 662, SD1-SD6):
 * pipeline, conversion and the signed-in person's next actions. A sales rep
 * or manager sees only their own (or their teams') figures. Read-only.
 */
export const GET = route(async (request) => {
  const home = await withCrm(request, searchParams(request).get("organisationId"), "read", (tx, { scope }) => salesHome(tx, scope));
  return json(home);
});
