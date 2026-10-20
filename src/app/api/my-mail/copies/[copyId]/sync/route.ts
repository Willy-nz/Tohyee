import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { copyForSync } from "@/lib/private-mail/store";
import { syncPrivateCopy } from "@/lib/private-mail/sync";

type Context = { params: Promise<{ copyId: string }> };

/** POST: "Sync now" for the Owner's own copy (PM3). Body: { organisationId }. The copying happens outside the request's transaction. */
export const POST = route<Context>(async (request, context) => {
  const { copyId } = await context.params;
  const body = await readJson(request);
  const { organisation, id } = await withOrganisation(request, body.organisationId, "sales_rep", async (tx, { membership }) => ({
    organisation: membership.organisation,
    id: await copyForSync(tx, await MailOwner.of(tx), copyId),
  }));
  const result = await syncPrivateCopy(organisation, id);
  return json({ copied: result.copied, removed: result.removed, deletedInMailbox: result.deletedInMailbox ?? 0 });
});
