import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { readJsonOrForm } from "@/lib/api/json-or-form";
import { createLeaveBooking, listLeaveBookings } from "@/lib/payroll/leave-records";

/** Leave bookings. Query: organisationId, employeeId?, from?, to?, includeCancelled?. Payroll access. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const bookings = await withPayrollAccess(request, params.get("organisationId"), (tx) =>
    listLeaveBookings(tx, {
      employeeId: params.get("employeeId") || undefined,
      from: params.get("from") || undefined,
      to: params.get("to") || undefined,
      includeCancelled: params.get("includeCancelled") === "true",
    }),
  );
  return json({ bookings });
});

/**
 * Books leave. JSON, or a form with the JSON in "data" and the written
 * agreement to recover holidays in advance as "advanceAgreement". Fields:
 * organisationId, idempotencyKey, employeeId, leaveType, startDate,
 * endDate?, dayHours? (hours that vary), hoursWorked? (a part day),
 * bereavementKind?, inAdvanceAgreed?, note?.
 */
export const POST = route(async (request) => {
  const { body, files } = await readJsonOrForm(request, ["advanceAgreement"]);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => createLeaveBooking(tx, { ...body, advanceAgreement: files.advanceAgreement }));
  return json(result, { status: result.created ? 201 : 200 });
});
