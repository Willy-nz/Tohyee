import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { myShifts } from "@/lib/payroll/rosters";

/** GET: your published shifts between `from` and `to` (RS4), from the employee record linked to your login. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const shifts = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => myShifts(tx, { from: params.get("from"), to: params.get("to") }));
  return json({ shifts });
});
