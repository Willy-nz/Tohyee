import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { addClockDevice, listClockDevices } from "@/lib/payroll/clock";
import { clockCookieHeader } from "@/lib/payroll/clock-cookie";

/** GET: the shared clock-in devices (RS5). Payroll access. */
export const GET = route(async (request) => {
  const devices = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => listClockDevices(tx));
  return json({ devices });
});

/**
 * Sets up the device this request comes from as a shared clock-in device:
 * its token goes into a cookie only the clock-in page's API reads. Do it on
 * the shop's device, then sign out there.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { device, token } = await withPayrollAccess(request, body.organisationId, (tx) => addClockDevice(tx, { name: body.name }));
  return json({ device }, { status: 201, headers: { "set-cookie": clockCookieHeader(request, token) } });
});
