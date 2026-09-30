import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { recordForeignOpeningBalance } from "@/lib/ledger/foreign";

type Context = { params: Promise<{ accountId: string }> };

/**
 * POST: a foreign-currency account's opening foreign balance (example FXB1):
 * `foreignBalance` as at `asAtDate`, once, for an account with postings from
 * before Tohyee kept foreign amounts. Posts nothing.
 */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    recordForeignOpeningBalance(tx, accountId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      asAtDate: body.asAtDate,
      foreignBalance: body.foreignBalance,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
