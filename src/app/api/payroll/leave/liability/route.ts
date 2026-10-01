import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { exportLeaveLiability, leaveLiabilityReport } from "@/lib/payroll/leave-reports";

/** The leave liability report (decision 28: shown, never posted). Query: organisationId, asAt?. Payroll access. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withPayrollAccess(request, params.get("organisationId"), (tx) => leaveLiabilityReport(tx, { asAt: params.get("asAt") || undefined }));
  return json({ report });
});

/** POST: the report as CSV, audited without figures. Body: { organisationId, asAt? }. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const file = await withPayrollAccess(request, body.organisationId, (tx) => exportLeaveLiability(tx, { asAt: body.asAt }));
  return new Response(file.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
