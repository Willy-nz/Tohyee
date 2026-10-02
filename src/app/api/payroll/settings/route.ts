import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { ForbiddenError } from "@/lib/errors";
import { getPayrollSettings, updatePayrollSettings } from "@/lib/payroll/pay-items";

/** Payroll settings (examples PRUN7, PPAY9). Reading needs payroll access; changing needs payroll access and the admin role. */
export const GET = route(async (request) => {
  const settings = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => getPayrollSettings(tx));
  return json({ settings });
});

/**
 * Body: { organisationId, approverMustDiffer?, irdPaymentFrequency? ("monthly" or "twice_monthly"),
 * leaveExpenseAccountCode?, leaveLiabilityAccountCode? (null or "" to clear; decision 184),
 * timesheetFirstDay? (1 Monday to 7 Sunday; decision 192), standardWeek? (hours; decision 199) }.
 */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withPayrollAccess(request, body.organisationId, (tx, { membership }) => {
    if (!roleAtLeast(membership.role, "admin")) throw new ForbiddenError("Only admins can change payroll settings.");
    return updatePayrollSettings(tx, {
      approverMustDiffer: body.approverMustDiffer,
      irdPaymentFrequency: body.irdPaymentFrequency,
      leaveExpenseAccountCode: body.leaveExpenseAccountCode,
      leaveLiabilityAccountCode: body.leaveLiabilityAccountCode,
      timesheetFirstDay: body.timesheetFirstDay,
      standardWeek: body.standardWeek,
    });
  });
  return json({ settings });
});
