import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { checkInboxMailbox, listInboxMailboxes } from "@/lib/bills/inbox-mailbox";

type Context = { params: Promise<{ mailboxId: string }> };

/** POST: checks the mailbox now (Check now), outside a long transaction. Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  const check = await checkInboxMailbox(organisation, actor, mailboxId);
  const mailboxes = await withOrganisation(request, body.organisationId, "viewer", (tx) => listInboxMailboxes(tx));
  return json({ check, mailboxes });
});
