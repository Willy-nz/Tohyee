import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { akahuMoney, akahuProblem, listAkahuAccounts } from "@/lib/bank/akahu/client";
import { akahuCredentialsFor } from "@/lib/bank/akahu/settings";

/** GET: the Akahu accounts this organisation can link, and which of its bank accounts each is linked to. */
export const GET = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const credentials = await withOrganisation(request, organisationId, "admin", (tx) => akahuCredentialsFor(tx));
  let accounts;
  try {
    accounts = await listAkahuAccounts(credentials);
  } catch (error) {
    throw akahuProblem(error);
  }
  const links = await withOrganisation(request, organisationId, "admin", async (tx) =>
    (
      await tx.query<{ account_id: string; akahu_account_id: string }>(
        "select account_id, akahu_account_id from bank_account_settings where akahu_account_id is not null",
      )
    ).rows,
  );
  const linkedTo = new Map(links.map((link) => [link.akahu_account_id, link.account_id]));
  return json({
    accounts: accounts.map((account) => ({
      id: account._id,
      name: account.name,
      formattedAccount: account.formatted_account ?? null,
      type: account.type ?? null,
      status: account.status ?? null,
      connectionName: account.connection?.name ?? null,
      balance: typeof account.balance?.current === "number" ? akahuMoney(account.balance.current, "account balance") : null,
      linkedAccountId: linkedTo.get(account._id) ?? null,
    })),
  });
});
