import { roleAtLeast } from "@/lib/auth/roles";
import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { accountForSync, listAccounts, syncAccount } from "@/lib/crm/mail/service";

type Context = { params: Promise<{ accountId: string }> };

/** "Sync now" (examples MAIL3-MAIL5). The network calls happen outside any database transaction. */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const { id, organisation } = await withOrganisation(request, body.organisationId, "viewer", async (tx, { membership }) => ({
    id: await accountForSync(tx, accountId, roleAtLeast(membership.role, "admin")),
    organisation: membership.organisation,
  }));
  const result = await syncAccount(organisation, id);
  const accounts = await withOrganisation(request, body.organisationId, "viewer", (tx) => listAccounts(tx));
  return json({ ...result, accounts });
});
