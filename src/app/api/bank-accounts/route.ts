import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createBankAccount, listBankAccounts } from "@/lib/bank/accounts";

/** GET: bank and credit card accounts with balances, lines to reconcile and bank feed status. `includeArchived=true` adds archived ones. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const bankAccounts = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listBankAccounts(tx, { includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ bankAccounts });
});

/** Adds a bank or credit card account (`accountType`: bank | credit_card, optional `currencyCode`) to the chart of accounts. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const bankAccount = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createBankAccount(tx, {
      code: body.code,
      name: body.name,
      accountType: body.accountType,
      description: body.description,
      currencyCode: body.currencyCode,
    }),
  );
  return json({ bankAccount }, { status: 201 });
});
