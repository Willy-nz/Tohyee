import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { getEmployee, setEmployeeArchived, updateEmployee } from "@/lib/payroll/employees";
import { ValidationError } from "@/lib/errors";
import { requireBoolean } from "@/lib/validation";

const EMPLOYEE_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "postalAddress",
  "dateOfBirth",
  "taxCode",
  "irdNumber",
  "kiwiSaverStatus",
  "kiwiSaverEmployeeRate",
  "kiwiSaverEmployerRate",
  "studentLoan",
  "payFrequency",
  "payBasis",
  "annualSalary",
  "hourlyRate",
  "ordinaryHoursPerWeek",
  "startDate",
  "finishDate",
  "bankAccount",
  "jobTitle",
  "reportsToId",
  "payGroupId",
  "employeeGroupId",
] as const;

export const GET = route<{ params: Promise<{ employeeId: string }> }>(async (request, context) => {
  const { employeeId } = await context.params;
  const params = searchParams(request);
  const employee = await withPayrollAccess(request, params.get("organisationId"), (tx) =>
    getEmployee(tx, employeeId),
  );
  return json({ employee });
});

export const PATCH = route<{ params: Promise<{ employeeId: string }> }>(async (request, context) => {
  const { employeeId } = await context.params;
  const body = await readJson(request);
  const fields = Object.fromEntries(EMPLOYEE_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
  const employee = await withPayrollAccess(request, body.organisationId, async (tx) => {
    if (body.isArchived === undefined) return updateEmployee(tx, employeeId, fields);
    if (Object.keys(fields).length > 0) {
      throw new ValidationError("Archive or restore an employee on its own, then save any other changes separately.");
    }
    return setEmployeeArchived(tx, employeeId, requireBoolean(body.isArchived, "isArchived"));
  });
  return json({ employee });
});
