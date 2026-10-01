import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { PUBLIC_HOLIDAY_YEARS } from "@/lib/payroll/leave/public-holiday-dates";
import { decidePublicHoliday, listPublicHolidayDecisions } from "@/lib/payroll/leave-records";

/** The public holiday dates Tohyee has (decision 22) and the decisions recorded (decision 21). Query: organisationId, employeeId?, from?, to?. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const decisions = await withPayrollAccess(request, params.get("organisationId"), (tx) =>
    listPublicHolidayDecisions(tx, { employeeId: params.get("employeeId") || undefined, from: params.get("from") || undefined, to: params.get("to") || undefined }),
  );
  return json({ years: PUBLIC_HOLIDAY_YEARS, decisions });
});

/**
 * Records whether a public holiday would otherwise have been a working day
 * for an employee and the hours worked on it (decisions 21, 23). Body:
 * { organisationId, employeeId, holidayDate, otherwiseWorking, hoursWorked?,
 * penalHourlyRate?, extraAmount?, suggestion?, note? }.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => decidePublicHoliday(tx, body));
  return json(result);
});
