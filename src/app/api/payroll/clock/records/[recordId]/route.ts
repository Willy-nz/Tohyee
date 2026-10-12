import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { enterClockOut } from "@/lib/payroll/clock";

type Context = { params: Promise<{ recordId: string }> };

/** Enters a missed clock-out (`clockOutAt`, `breakMinutes`, `reason`; RS8), or `retry: true` to put a closed one on its timesheet again. */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const record = await withPayrollAccess(request, body.organisationId, (tx) =>
    enterClockOut(tx, recordId, { clockOutAt: body.clockOutAt, breakMinutes: body.breakMinutes, reason: body.reason, retry: body.retry }),
  );
  return json({ record });
});
