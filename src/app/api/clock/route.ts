import { json, readJson, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import { assertRemoteAllowed } from "@/lib/auth/remote";
import { type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { clockBoard, clockPunch, deviceActor, deviceFromToken, parseDeviceToken } from "@/lib/payroll/clock";
import { clearClockCookieHeader, readClockCookie } from "@/lib/payroll/clock-cookie";
import { getOrganisation } from "@/lib/organisations/registry";

/*
 * The shared clock-in device (RS5). No one is signed in: the device's own
 * token (a cookie set when someone with payroll access set it up) is the
 * only key, and it can only show who's in and clock people in and out.
 */

const NOT_SET_UP = "This device isn't set up for clocking in. Someone with payroll access can set it up under Payroll > Clock-ins.";

/** Runs `work` as the device the request's cookie belongs to. */
async function onDevice<T>(request: Request, work: (tx: OrgTx, device: { id: string; name: string }) => Promise<T>): Promise<T> {
  await assertRemoteAllowed(request.headers);
  const token = parseDeviceToken(readClockCookie(request));
  if (!token) throw new UnauthorizedError(NOT_SET_UP);
  const organisation = await getOrganisation(token.organisationId);
  if (!organisation) throw new UnauthorizedError(NOT_SET_UP);
  // Look the device up first (its name is the actor), then do the work as it.
  const device = await withOrganisationTransaction(organisation, { userId: null, email: "clock-device@tohyee" }, (tx) => deviceFromToken(tx, token));
  return withOrganisationTransaction(organisation, deviceActor(device.name), (tx) => work(tx, device));
}

/** GET: the device's name and who can clock in, with whether each is in, on a break or out. */
export const GET = route(async (request) => {
  try {
    const result = await onDevice(request, async (tx, device) => ({ deviceName: device.name, employees: await clockBoard(tx) }));
    return json(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) return json({ error: error.message, code: "not_set_up" }, { status: 401, headers: { "set-cookie": clearClockCookieHeader(request) } });
    throw error;
  }
});

/** Clocks someone in or out, or starts or ends a break: `employeeId`, `pin`, `action` (in, out, break_start, break_end). */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const result = await onDevice(request, (tx, device) => clockPunch(tx, device, { employeeId: body.employeeId, pin: body.pin, action: body.action }));
  // A wrong PIN is counted (committed above) and refused here.
  if (!result.ok) throw new ForbiddenError(result.message);
  return json(result);
});
