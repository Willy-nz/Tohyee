import { readJson, route, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { hasPayrollAccess } from "@/lib/payroll/access";
import { exportClaim } from "@/lib/rd/claim";

/**
 * POST: the claim report as CSV (viewers and above; RD42, decision 64). The
 * export's summary figures are kept in the R&D history with who exported it
 * and when; rows naming an employee only for people with payroll access.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const file = await withOrganisation(request, body.organisationId, "viewer", async (tx, { membership }) =>
    exportClaim(tx, body.incomeYear, {
      payrollDetail: roleAtLeast(membership.role, "bookkeeper") && (await hasPayrollAccess(tx)),
      showReminders: false,
    }),
  );
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
