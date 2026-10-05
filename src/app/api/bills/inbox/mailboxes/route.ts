import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createInboxMailbox, listInboxMailboxes } from "@/lib/bills/inbox-mailbox";

/** GET: the mailboxes the bills inbox reads (BI2). Viewers and above. */
export const GET = route(async (request) => {
  const mailboxes = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listInboxMailboxes(tx));
  return json({ mailboxes });
});

/**
 * POST: reads a mailbox folder or label into the inbox (admins): `mailKind`
 * "crm" with `mailAccountId`, or "imap" with `imapHost`, `imapUsername`,
 * `imapPassword`; `mailFolderId`, `mailFolderName`; `syncEveryHours` 1-24
 * (1 when blank).
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const mailbox = await withOrganisation(request, body.organisationId, "admin", (tx) => createInboxMailbox(tx, body));
  return json({ mailbox }, { status: 201 });
});
