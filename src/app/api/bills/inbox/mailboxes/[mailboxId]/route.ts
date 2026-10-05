import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteInboxMailbox, updateInboxMailbox } from "@/lib/bills/inbox-mailbox";

type Context = { params: Promise<{ mailboxId: string }> };

/** PATCH: how often it's checked (`syncEveryHours`, 1-24). Admins. */
export const PATCH = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const body = await readJson(request);
  const mailbox = await withOrganisation(request, body.organisationId, "admin", (tx) => updateInboxMailbox(tx, mailboxId, body));
  return json({ mailbox });
});

/** DELETE: stops reading the mailbox. Its items stay. Admins. */
export const DELETE = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => deleteInboxMailbox(tx, mailboxId));
  return json({ deleted: true });
});
