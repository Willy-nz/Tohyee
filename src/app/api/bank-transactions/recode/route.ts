import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { findRecodable, planRecode, recodeBankTransactions } from "@/lib/bank/recode";

/** GET: posted spend and receive money to choose from (RC6): bankAccountId, accountCode, contactId, text, from, to. Bookkeepers. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const transactions = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) =>
    findRecodable(tx, {
      bankAccountId: params.get("bankAccountId"),
      accountCode: params.get("accountCode"),
      contactId: params.get("contactId"),
      text: params.get("text"),
      from: params.get("from"),
      to: params.get("to"),
    }),
  );
  return json({ transactions });
});

/**
 * POST: recodes them in place (RC1-RC5). Without `previewHash` it's the
 * preview; with it, the recode (`bankTransactionIds`, `change`
 * {fromAccountCode, accountCode, taxCode, contactId, description},
 * `idempotencyKey`). Bookkeepers.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx): Promise<unknown> =>
    body.previewHash
      ? recodeBankTransactions(tx, { bankTransactionIds: body.bankTransactionIds, change: body.change, previewHash: body.previewHash, idempotencyKey: body.idempotencyKey })
      : planRecode(tx, { bankTransactionIds: body.bankTransactionIds, change: body.change }),
  );
  return json(result);
});
