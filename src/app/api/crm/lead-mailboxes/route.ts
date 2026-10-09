import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createLeadMailbox, listLeadMailboxes } from "@/lib/crm/lead-intake";

/** Mailbox folders whose emails become leads (decision 493). Admins. */
export const GET = route(async (request) => {
  const mailboxes = await withCrm(request, searchParams(request).get("organisationId"), "admin", (tx) => listLeadMailboxes(tx));
  return json({ mailboxes });
});

/** Reads a folder or label into leads, as you: `mailKind` crm (`mailAccountId`) or imap, `mailFolderId`, `mailFolderName`, `syncEveryHours`. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const mailbox = await withCrm(request, body.organisationId, "admin", (tx) => createLeadMailbox(tx, body));
  return json({ mailbox }, { status: 201 });
});
