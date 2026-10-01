import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { exportLeaveRecord, getLeaveRecord } from "@/lib/payroll/leave-reports";

type Context = { params: Promise<{ employeeId: string }> };

/** The employee's holiday and leave record (s 81; HL40, HL41). Payroll access. */
export const GET = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const record = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => getLeaveRecord(tx, employeeId));
  return json({ record });
});

/** POST: the record as CSV, audited without figures. Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { employeeId } = await context.params;
  const body = await readJson(request);
  const file = await withPayrollAccess(request, body.organisationId, (tx) => exportLeaveRecord(tx, employeeId));
  return new Response(file.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
