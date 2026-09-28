import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { akahuProblem, listAkahuAccounts } from "@/lib/bank/akahu/client";
import { akahuCredentialsFor, linkBankFeed, unlinkBankFeed } from "@/lib/bank/akahu/settings";
import { ValidationError } from "@/lib/errors";

type Context = { params: Promise<{ accountId: string }> };

/**
 * Links an Akahu account to this bank or credit card account (`akahuAccountId`,
 * `startDate`: the first date to bring in). The Akahu account is checked with
 * Akahu first, outside any database transaction.
 */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const credentials = await withOrganisation(request, body.organisationId, "admin", (tx) => akahuCredentialsFor(tx));
  let accounts;
  try {
    accounts = await listAkahuAccounts(credentials);
  } catch (error) {
    throw akahuProblem(error);
  }
  const akahuAccount = accounts.find((account) => account._id === body.akahuAccountId);
  if (!akahuAccount) throw new ValidationError("Akahu doesn't have that account for this connection.");
  await withOrganisation(request, body.organisationId, "admin", (tx) =>
    linkBankFeed(tx, accountId, {
      akahuAccountId: akahuAccount._id,
      akahuAccountName: [akahuAccount.name, akahuAccount.formatted_account].filter(Boolean).join(" · "),
      connectionName: akahuAccount.connection?.name ?? null,
      startDate: body.startDate,
    }),
  );
  return json({ linked: true }, { status: 201 });
});

/** Stops the account's bank feed. Lines already brought in stay. */
export const DELETE = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => unlinkBankFeed(tx, accountId));
  return json({ linked: false });
});
