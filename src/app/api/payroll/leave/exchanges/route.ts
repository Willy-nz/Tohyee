import { json, route, withPayrollAccess } from "@/lib/api/http";
import { readJsonOrForm } from "@/lib/api/json-or-form";
import { exchangeAlternativeHoliday } from "@/lib/payroll/leave-records";

/**
 * Records an alternative holiday exchanged for payment (s 61; decision 24).
 * JSON, or a form with the JSON in "data" and the agreement as "agreement".
 * Fields: organisationId, idempotencyKey, employeeId, aroseOn, requestedOn,
 * agreedOn?, amount?, agreementNote.
 */
export const POST = route(async (request) => {
  const { body, files } = await readJsonOrForm(request, ["agreement"]);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => exchangeAlternativeHoliday(tx, { ...body, agreement: files.agreement }));
  return json(result, { status: result.created ? 201 : 200 });
});
