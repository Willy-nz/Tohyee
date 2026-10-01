import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { ForbiddenError } from "@/lib/errors";
import { updatePayItem } from "@/lib/payroll/pay-items";

type Context = { params: Promise<{ payItemId: string }> };

/** Body: { organisationId, name?, accountCode?, rateMultiplier? (overtime), isArchived? }. Admins with payroll access (PRUN10). */
export const PATCH = route<Context>(async (request, context) => {
  const { payItemId } = await context.params;
  const body = await readJson(request);
  const input = Object.fromEntries(Object.entries(body).filter(([field]) => field !== "organisationId"));
  const result = await withPayrollAccess(request, body.organisationId, (tx, { membership }) => {
    if (!roleAtLeast(membership.role, "admin")) throw new ForbiddenError("Only admins can change pay items.");
    return updatePayItem(tx, payItemId, input);
  });
  return json(result);
});
