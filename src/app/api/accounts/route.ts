import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createAccount, listAccounts } from "@/lib/accounts/service";

/** Chart of accounts. `includeArchived=true` also returns archived accounts. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const accounts = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listAccounts(tx, { includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ accounts });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const account = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createAccount(tx, {
      code: body.code,
      name: body.name,
      accountType: body.accountType,
      description: body.description,
      currencyCode: body.currencyCode,
    }),
  );
  return json({ account }, { status: 201 });
});
