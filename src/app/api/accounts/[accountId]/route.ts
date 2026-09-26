import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateAccount } from "@/lib/accounts/service";

export const PATCH = route<{ params: Promise<{ accountId: string }> }>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const account = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateAccount(tx, accountId, {
      code: body.code,
      name: body.name,
      accountType: body.accountType,
      description: body.description,
      currencyCode: body.currencyCode,
      isActive: body.isActive,
    }),
  );
  return json({ account });
});
