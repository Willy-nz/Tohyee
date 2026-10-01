import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { parsePayrollReportName } from "@/lib/payroll/report-figures";
import { runPayrollReport } from "@/lib/payroll/reports";

/**
 * GET: a payroll report (PREP1-PREP8): `report` is labour-cost, summary,
 * reconciliation, headcount, earnings or ird; `from` and `to` are pay
 * dates; filters `groupBy`, `departmentId`, `projectId`, `rdActivityId`,
 * `employeeId`, `payItemId`, and for headcount `date` and `standardWeek`.
 * Bookkeeper and payroll access (decision 105). Read-only.
 */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const input = Object.fromEntries(query.entries());
  const result = await withPayrollAccess(request, query.get("organisationId"), (tx) => runPayrollReport(tx, parsePayrollReportName(query.get("report")), input));
  return json({ report: result.data });
});
