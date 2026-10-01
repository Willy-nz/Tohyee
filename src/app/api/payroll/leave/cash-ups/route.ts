import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { readJsonOrForm } from "@/lib/api/json-or-form";
import { createCashUp, listCashUps } from "@/lib/payroll/leave-records";

/** Cash-ups (s 28A-s 28F). Query: organisationId, employeeId?. Payroll access. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const cashUps = await withPayrollAccess(request, params.get("organisationId"), (tx) => listCashUps(tx, { employeeId: params.get("employeeId") || undefined }));
  return json({ cashUps });
});

/**
 * Records an agreed cash-up (decision 29): a form with the JSON in "data"
 * and the employee's written request as "request" and the written answer as
 * "answer". Fields: organisationId, idempotencyKey, employeeId, requestedOn,
 * agreedOn?, weeks or hours.
 */
export const POST = route(async (request) => {
  const { body, files } = await readJsonOrForm(request, ["request", "answer"]);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => createCashUp(tx, { ...body, request: files.request, answer: files.answer }));
  return json(result, { status: result.created ? 201 : 200 });
});
