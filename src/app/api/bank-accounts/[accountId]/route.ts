import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getBankAccount } from "@/lib/bank/accounts";

type Context = { params: Promise<{ accountId: string }> };

/** GET: one bank or credit card account with its balances and bank feed status. */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const bankAccount = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getBankAccount(tx, accountId),
  );
  return json({ bankAccount });
});
