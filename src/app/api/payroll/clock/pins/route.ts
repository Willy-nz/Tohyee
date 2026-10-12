import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listClockPins, setClockPin } from "@/lib/payroll/clock";

/** GET: which employees have a clock-in PIN, and any locked by wrong PINs. Never the PINs. */
export const GET = route(async (request) => {
  const pins = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => listClockPins(tx));
  return json({ pins });
});

/** Sets an employee's PIN (4 to 8 digits), or clears it (`pin: null`). Setting it also unlocks it. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const pins = await withPayrollAccess(request, body.organisationId, (tx) => setClockPin(tx, { employeeId: body.employeeId, pin: body.pin }));
  return json({ pins });
});
