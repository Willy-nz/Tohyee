import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { cancelLeaveBooking } from "@/lib/payroll/leave-records";

type Context = { params: Promise<{ bookingId: string }> };

/** Cancels a booking no approved pay run has paid. Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { bookingId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => cancelLeaveBooking(tx, bookingId));
  return json(result);
});
