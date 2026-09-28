import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getBankTransaction } from "@/lib/bank/transactions";

type Context = { params: Promise<{ bankTransactionId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { bankTransactionId } = await context.params;
  const bankTransaction = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getBankTransaction(tx, bankTransactionId),
  );
  return json({ bankTransaction });
});
