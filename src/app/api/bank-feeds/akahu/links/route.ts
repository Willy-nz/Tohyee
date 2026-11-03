import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { akahuProblem, listAkahuAccounts } from "@/lib/bank/akahu/client";
import { akahuCredentialsFor, linkBankFeeds } from "@/lib/bank/akahu/settings";

/**
 * Links several Akahu accounts of one login to bank and credit card accounts
 * at once, the guided setup's last step (#543, decision 1288): `connectionId`,
 * `startDate` and `links: [{ akahuAccountId, accountId }]`. All or none. Akahu
 * is asked for the login's accounts first, outside any database transaction.
 * The first sync is then run per account (POST /api/bank-accounts/{id}/feed/sync).
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const credentials = await withOrganisation(request, body.organisationId, "admin", (tx) => akahuCredentialsFor(tx, body.connectionId));
  let available;
  try {
    available = await listAkahuAccounts(credentials);
  } catch (error) {
    throw akahuProblem(error);
  }
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    linkBankFeeds(tx, { connectionId: credentials.connectionId, startDate: body.startDate, links: body.links }, available),
  );
  return json(result, { status: 201 });
});
