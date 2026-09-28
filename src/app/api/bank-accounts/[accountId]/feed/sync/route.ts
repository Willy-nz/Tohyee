import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { getBankAccount } from "@/lib/bank/accounts";
import { syncBankFeedAccount } from "@/lib/bank/akahu/sync";

type Context = { params: Promise<{ accountId: string }> };

/** Syncs the account's bank feed now: asks Akahu to refresh, then adds new settled transactions. */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const result = await syncBankFeedAccount(organisation, accountId, actor, { refresh: true });
  const bankAccount = await withOrganisation(request, body.organisationId, "viewer", (tx) => getBankAccount(tx, accountId));
  return json({ result, bankAccount });
});
