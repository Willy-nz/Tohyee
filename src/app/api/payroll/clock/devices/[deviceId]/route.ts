import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { revokeClockDevice } from "@/lib/payroll/clock";

type Context = { params: Promise<{ deviceId: string }> };

/** Stops a device: it can't clock anyone in again. */
export const DELETE = route<Context>(async (request, context) => {
  const { deviceId } = await context.params;
  const body = await readJson(request);
  const devices = await withPayrollAccess(request, body.organisationId, (tx) => revokeClockDevice(tx, deviceId));
  return json({ devices });
});
