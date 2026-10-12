import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listClockRecords } from "@/lib/payroll/clock";

/** GET: clock-ins between `from` and `to`, and every one needing attention (RS5, RS8). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withPayrollAccess(request, params.get("organisationId"), (tx) => listClockRecords(tx, { from: params.get("from"), to: params.get("to") }));
  return json(result);
});
