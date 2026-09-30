import { json, readJson, route, withOrganisationRunner } from "@/lib/api/http";
import { cashCodeStatementLines } from "@/lib/bank/cash-coding";

type Context = { params: Promise<{ accountId: string }> };

/**
 * POST: bulk coding ("cash coding", examples BK22, BK23). `lines` are the
 * ticked statement lines, `{ lineId, ...values for this line }`; `contactId`,
 * `accountCode`, `taxCode`, `description` and `tracking` at the top are for
 * every line. Each line becomes its own spend or receive money reconciled to
 * it, in its own transaction; the result lists what happened to each.
 */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisationRunner(request, body.organisationId, "bookkeeper", (run) => cashCodeStatementLines(run, accountId, body));
  return json(result);
});
