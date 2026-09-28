import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidBankTransaction } from "@/lib/bank/transactions";

type Context = { params: Promise<{ bankTransactionId: string }> };

/** Voids a bank transaction on `voidDate` (not while reconciled): posts the exact reversal. */
export const POST = route<Context>(async (request, context) => {
  const { bankTransactionId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidBankTransaction(tx, bankTransactionId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
