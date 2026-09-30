import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createTransfer, listTransfers } from "@/lib/bank/transactions";

/** GET: transfers, newest first. Filters: accountId (into or out of it), limit (max 500). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const transfers = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listTransfers(tx, { accountId: params.get("accountId"), limit: params.get("limit") }),
  );
  return json({ transfers });
});

/**
 * Moves money between two bank or credit card accounts: Dr to / Cr from on
 * `date`. `amount` is in the from account's currency; between a base-currency
 * and a foreign-currency account, `toAmount` is what arrived (FXB5, FXB6).
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createTransfer(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      fromAccountCode: body.fromAccountCode,
      toAccountCode: body.toAccountCode,
      date: body.date,
      amount: body.amount,
      toAmount: body.toAmount,
      reference: body.reference,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
