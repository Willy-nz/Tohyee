import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { ForbiddenError } from "@/lib/errors";
import { createPayItem, listPayItems } from "@/lib/payroll/pay-items";

/** Pay items (example PRUN10). Reading needs payroll access; adding needs payroll access and the admin role. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const payItems = await withPayrollAccess(request, params.get("organisationId"), (tx) =>
    listPayItems(tx, { includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ payItems });
});

/**
 * Body: { organisationId, idempotencyKey, name, kind, accountCode, rateMultiplier? (overtime), taxable? and
 * countsForKiwiSaver? (allowances), discretionary? (extra pays and taxable allowances: not gross earnings for holiday pay, decision 139) }.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const input = Object.fromEntries(Object.entries(body).filter(([field]) => field !== "organisationId"));
  const result = await withPayrollAccess(request, body.organisationId, (tx, { membership }) => {
    if (!roleAtLeast(membership.role, "admin")) throw new ForbiddenError("Only admins can add pay items.");
    return createPayItem(tx, input);
  });
  return json(result, { status: result.created ? 201 : 200 });
});
