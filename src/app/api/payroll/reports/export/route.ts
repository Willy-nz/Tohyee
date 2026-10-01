import { readJson, route, withPayrollAccess } from "@/lib/api/http";
import { exportPayrollReport } from "@/lib/payroll/report-export";

/**
 * POST: a payroll report as CSV (PREP8, decision 109). Body: { organisationId,
 * report, from, to, ...filters } as the GET. Bookkeeper and payroll access.
 * Records an audit event without figures; posts nothing.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const file = await withPayrollAccess(request, body.organisationId, (tx) => exportPayrollReport(tx, body.report, body));
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
