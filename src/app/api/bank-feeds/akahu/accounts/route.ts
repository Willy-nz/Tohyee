import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { type AkahuAccount, akahuMoney, akahuProblem, listAkahuAccounts } from "@/lib/bank/akahu/client";
import { akahuCredentialsFor, allAkahuCredentials } from "@/lib/bank/akahu/settings";

/** The balance shown when choosing an account to link: blank rather than rounded if it isn't whole cents. */
function shownBalance(value: unknown): string | null {
  if (typeof value !== "number") return null;
  try {
    return akahuMoney(value, "Akahu's account balance");
  } catch {
    return null;
  }
}

/**
 * GET: the Akahu accounts this organisation can link, from every login (BK31),
 * each with its login and which of its bank accounts it's linked to. A login
 * whose tokens are refused is listed in `problems` instead (BK33).
 */
export const GET = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const logins = await withOrganisation(request, organisationId, "admin", (tx) => allAkahuCredentials(tx));
  if (logins.length === 0) await withOrganisation(request, organisationId, "admin", (tx) => akahuCredentialsFor(tx));
  const found: Array<{ login: (typeof logins)[number]; accounts: AkahuAccount[] }> = [];
  const problems: Array<{ connectionId: string; loginName: string; message: string }> = [];
  for (const login of logins) {
    try {
      found.push({ login, accounts: await listAkahuAccounts(login) });
    } catch (error) {
      problems.push({ connectionId: login.connectionId, loginName: login.name, message: akahuProblem(error).message });
    }
  }
  // With one login and its tokens refused, say so as before.
  if (logins.length === 1 && problems.length === 1) throw akahuProblem(new Error(problems[0].message));
  const links = await withOrganisation(request, organisationId, "admin", async (tx) =>
    (
      await tx.query<{ account_id: string; akahu_account_id: string }>(
        "select account_id, akahu_account_id from bank_account_settings where akahu_account_id is not null",
      )
    ).rows,
  );
  const linkedTo = new Map(links.map((link) => [link.akahu_account_id, link.account_id]));
  return json({
    accounts: found.flatMap(({ login, accounts }) =>
      accounts.map((account) => ({
        id: account._id,
        name: account.name,
        formattedAccount: account.formatted_account ?? null,
        type: account.type ?? null,
        status: account.status ?? null,
        connectionName: account.connection?.name ?? null,
        balance: shownBalance(account.balance?.current),
        linkedAccountId: linkedTo.get(account._id) ?? null,
        connectionId: login.connectionId,
        loginName: login.name,
        // BK31: "Will's BNZ login · BNZ Savings" when there are several logins.
        label: logins.length > 1 ? `${login.name} · ${account.name}` : account.name,
      })),
    ),
    problems,
  });
});
