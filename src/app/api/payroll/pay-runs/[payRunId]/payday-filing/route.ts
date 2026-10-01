import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { getPayRunPaydayFiling, makePayRunPaydayFilingFile } from "@/lib/payroll/payday-filing-service";

type Context = { params: Promise<{ payRunId: string }> };

/**
 * A pay run's payday filing (PF5, PF6): its due date, whether the settings
 * are ready, and who starts in the pay period. Bookkeeper and payroll access.
 */
export const GET = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const filing = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => getPayRunPaydayFiling(tx, payRunId));
  return json({ filing });
});

/**
 * Makes IRD's employment information file for an approved pay run (PF1-PF5,
 * PF7, PF8). Bookkeeper and payroll access. Posts nothing and marks nothing
 * as filed; upload the file in myIR.
 * Body: { organisationId }. Returns the file's name, type and text, its
 * totals, due date and SHA-256.
 */
export const POST = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const body = await readJson(request);
  const file = await withPayrollAccess(request, body.organisationId, (tx) => makePayRunPaydayFilingFile(tx, payRunId));
  return json({ file }, { headers: { "cache-control": "no-store" } });
});
