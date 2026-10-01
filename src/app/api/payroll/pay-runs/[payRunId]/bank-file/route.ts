import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { makePayRunBankFile } from "@/lib/payroll/bank-file-service";

type Context = { params: Promise<{ payRunId: string }> };

/**
 * Makes the bank direct credit file for an approved pay run's unpaid net
 * wages (PBF1-PBF6). Bookkeeper and payroll access. Posts nothing and marks
 * nothing paid; record the wage payment afterwards.
 * Body: { organisationId, bankAccountCode, dueDate?, statementLines? ("one" or "each", BNZ) }.
 * Returns the file's name, type and text, with its count, total and hash total.
 */
export const POST = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const body = await readJson(request);
  const file = await withPayrollAccess(request, body.organisationId, (tx) =>
    makePayRunBankFile(tx, payRunId, { bankAccountCode: body.bankAccountCode, dueDate: body.dueDate, statementLines: body.statementLines }),
  );
  return json({ file }, { headers: { "cache-control": "no-store" } });
});
