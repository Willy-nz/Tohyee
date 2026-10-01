import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { updateAllDrafts } from "@/lib/payroll/leave-pay-runs";
import { listLeaveBookings, listUnpaidLeave } from "@/lib/payroll/leave-records";
import { getLeaveSummary } from "@/lib/payroll/leave-reports";
import { addLeaveSettings, listLeaveSettings } from "@/lib/payroll/leave-settings";

type Context = { params: Promise<{ employeeId: string }> };

/** An employee's leave: balances at a date, their usual week and settings, unpaid leave and bookings. Payroll access. */
export const GET = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const params = searchParams(request);
  const result = await withPayrollAccess(request, params.get("organisationId"), async (tx) => ({
    summary: await getLeaveSummary(tx, employeeId, params.get("asAt") || undefined),
    settings: await listLeaveSettings(tx, employeeId),
    unpaidLeave: await listUnpaidLeave(tx, employeeId),
    bookings: await listLeaveBookings(tx, { employeeId, includeCancelled: true }),
  }));
  return json(result);
});

/**
 * Saves the usual week and leave settings from a date (decisions 9, 11, 13,
 * 19, 22, 142). Body: { organisationId, idempotencyKey, effectiveFrom?,
 * pattern, dailyPay, adpReason?, annualPaidInPeriod, partDaySickAgreed?,
 * employmentType?, anniversaryRegion?, note? }. Drafts are worked out again.
 */
export const POST = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, async (tx) => {
    const saved = await addLeaveSettings(tx, employeeId, body);
    const payRuns = saved.created ? await updateAllDrafts(tx, employeeId) : [];
    return { ...saved, payRuns };
  });
  return json(result, { status: result.created ? 201 : 200 });
});
