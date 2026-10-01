import { json, route, withPayrollAccess } from "@/lib/api/http";
import { readJsonOrForm } from "@/lib/api/json-or-form";
import { addUnpaidLeave } from "@/lib/payroll/leave-records";

/**
 * Records unpaid leave (s 16(2); decision 14). JSON, or a form with the JSON
 * in "data" and the written agreement to count it as "agreement". Fields:
 * organisationId, idempotencyKey, employeeId, startDate, endDate, reason?,
 * agreedToCount?, note?.
 */
export const POST = route(async (request) => {
  const { body, files } = await readJsonOrForm(request, ["agreement"]);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => addUnpaidLeave(tx, { ...body, agreement: files.agreement }));
  return json(result, { status: result.created ? 201 : 200 });
});
