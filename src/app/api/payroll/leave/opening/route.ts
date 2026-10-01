import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { readJsonOrForm } from "@/lib/api/json-or-form";
import { getOpeningBalances, saveOpeningBalances } from "@/lib/payroll/leave-opening";

/** An employee's opening leave balances (decision 168). Query: organisationId, employeeId. Payroll access. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const opening = await withPayrollAccess(request, params.get("organisationId"), (tx) => getOpeningBalances(tx, params.get("employeeId")));
  return json({ opening });
});

/**
 * Enters or replaces opening balances (decision 168; HL43): a form with the
 * JSON in "data" and the previous payroll's report as "report". Fields:
 * organisationId, idempotencyKey, employeeId, asAt, annualWeeks,
 * annualLastEntitled?, annualCashedUpWeeks?, annualAdvancePaid?, sickDays,
 * familyViolenceDays, alternativeHolidays[], earnings[] (periodStart,
 * periodEnd, gross, irregular?, days), source.
 */
export const POST = route(async (request) => {
  const { body, files } = await readJsonOrForm(request, ["report"]);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => saveOpeningBalances(tx, { ...body, report: files.report }));
  return json(result, { status: result.created ? 201 : 200 });
});
