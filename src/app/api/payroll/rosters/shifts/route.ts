import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { addShift } from "@/lib/payroll/rosters";

/** Adds a shift (RS1-RS3). A day the employee is unavailable needs `unavailableReason`. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const roster = await withPayrollAccess(request, body.organisationId, (tx) =>
    addShift(tx, {
      areaId: body.areaId,
      employeeId: body.employeeId,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      breakMinutes: body.breakMinutes,
      unavailableReason: body.unavailableReason,
    }),
  );
  return json({ roster }, { status: 201 });
});
