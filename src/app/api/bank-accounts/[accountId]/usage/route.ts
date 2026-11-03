import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getAccountUsage, setAccountUsage } from "@/lib/bank/mixed-use";

type Context = { params: Promise<{ accountId: string }> };

/** GET: how the account is used (#545, MU1). */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const account = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getAccountUsage(tx, accountId));
  return json({ account });
});

/** PUT: `usage` (business, mixed or personal) and `ownerAccountCode` (MU1, MU12, MU13). Admins, as for adding accounts. */
export const PUT = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const account = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    setAccountUsage(tx, accountId, { usage: body.usage, ownerAccountCode: body.ownerAccountCode }),
  );
  return json({ account });
});
