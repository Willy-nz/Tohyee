import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { getIrdPeriod, listIrdPeriods, recordIrdPayment } from "@/lib/payroll/ird-payments";

/**
 * What's owing to IRD per period, with due dates (PPAY4, PPAY9). With
 * `periodStart`, that one period. Bookkeeper and payroll access.
 */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const periodStart = query.get("periodStart");
  return withPayrollAccess(request, query.get("organisationId"), async (tx) =>
    periodStart ? json({ period: await getIrdPeriod(tx, periodStart) }) : json(await listIrdPeriods(tx)),
  );
});

/**
 * Pays IRD for one period (PPAY5, PPAY6).
 * Body: { organisationId, idempotencyKey, periodStart, paymentDate, bankAccountCode, lines: [{ liability, amount }], source? }.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    recordIrdPayment(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      periodStart: body.periodStart,
      paymentDate: body.paymentDate,
      bankAccountCode: body.bankAccountCode,
      lines: body.lines,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
