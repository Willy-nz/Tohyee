import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { removeShift, updateShift } from "@/lib/payroll/rosters";

type Context = { params: Promise<{ shiftId: string }> };

export const PATCH = route<Context>(async (request, context) => {
  const { shiftId } = await context.params;
  const body = await readJson(request);
  const roster = await withPayrollAccess(request, body.organisationId, (tx) =>
    updateShift(tx, shiftId, { employeeId: body.employeeId, startsAt: body.startsAt, endsAt: body.endsAt, breakMinutes: body.breakMinutes, unavailableReason: body.unavailableReason }),
  );
  return json({ roster });
});

export const DELETE = route<Context>(async (request, context) => {
  const { shiftId } = await context.params;
  const body = await readJson(request);
  const roster = await withPayrollAccess(request, body.organisationId, (tx) => removeShift(tx, shiftId));
  return json({ roster });
});
