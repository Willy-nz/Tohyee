import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { updateEmployeeGroup, updatePayGroup } from "@/lib/payroll/groups";

type Context = { params: Promise<{ groupId: string }> };

/** Body: { organisationId, kind: "pay" | "employee", name?, payFrequency? (pay groups), isArchived? }. */
export const PATCH = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const body = await readJson(request);
  const fields = Object.fromEntries(
    (["name", "payFrequency", "isArchived"] as const).filter((field) => body[field] !== undefined).map((field) => [field, body[field]]),
  );
  const result = await withPayrollAccess(request, body.organisationId, (tx) => {
    if (body.kind === "pay") return updatePayGroup(tx, groupId, fields);
    if (body.kind === "employee") {
      if (fields.payFrequency !== undefined) throw new ValidationError("Employee groups don't have a pay frequency.");
      return updateEmployeeGroup(tx, groupId, fields);
    }
    throw new ValidationError('kind must be "pay" or "employee".');
  });
  return json(result);
});
