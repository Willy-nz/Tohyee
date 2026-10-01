import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { kickEmailOutbox } from "@/lib/email/outbox";
import { listPayslips, queuePayslipEmails } from "@/lib/payroll/payslips";

type Context = { params: Promise<{ payRunId: string }> };

/** The payslips on an approved pay run, with each employee's latest payslip email (PSLIP5). Bookkeeper and payroll access. */
export const GET = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const result = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => listPayslips(tx, payRunId));
  return json(result);
});

/**
 * Emails payslips to the employees (all, or `employeeIds`), each with its
 * PDF; the background job sends them (PSLIP5). Idempotent.
 * Body: { organisationId, idempotencyKey, employeeIds?, source? }.
 */
export const POST = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, async (tx) => ({
    ...(await queuePayslipEmails(tx, payRunId, { employeeIds: body.employeeIds, idempotencyKey: body.idempotencyKey, source: body.source })),
    organisationId: tx.organisationId,
  }));
  if (result.created) kickEmailOutbox(result.organisationId);
  return json({ created: result.created, emails: result.emails, skipped: result.skipped }, { status: result.created ? 201 : 200 });
});
