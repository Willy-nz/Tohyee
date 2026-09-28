import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createBankTransaction, listBankTransactions } from "@/lib/bank/transactions";

/** GET: bank transactions, newest first. Filters: accountId, limit (max 500). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const bankTransactions = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listBankTransactions(tx, { accountId: params.get("accountId"), limit: params.get("limit") }),
  );
  return json({ bankTransactions });
});

/** Posts spend or receive money (`kind`) on a bank or credit card account. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createBankTransaction(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      kind: body.kind,
      accountId: body.accountId,
      contactId: body.contactId,
      date: body.date,
      reference: body.reference,
      amountsMode: body.amountsMode,
      lines: body.lines,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
