import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { chooseMailboxFolders, mailboxFolderChoices, mailboxForFolders } from "@/lib/farming/calendar";

type Context = { params: Promise<{ mailboxId: string }> };

/**
 * GET ?organisationId=: the mailbox's folders (Outlook) or labels (Gmail),
 * fetched from the mailbox now, to choose which are read (FC25). The
 * member's own mailbox only; the names are private to them.
 */
export const GET = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const { organisation, id } = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx, { membership }) => ({
    organisation: membership.organisation,
    id: await mailboxForFolders(tx, mailboxId),
  }));
  const folders = await mailboxFolderChoices(organisation, id);
  return json({ folders });
});

/**
 * PUT: the folders to read (FC25-FC27). Body: { organisationId, folders:
 * [{ id, includeSubfolders }] }. Each must be one of the mailbox's folders
 * now; folders taken off have what was taken from them deleted.
 */
export const PUT = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const body = await readJson(request);
  const { organisation, id } = await withOrganisation(request, body.organisationId, "viewer", async (tx, { membership }) => ({
    organisation: membership.organisation,
    id: await mailboxForFolders(tx, mailboxId),
  }));
  const available = await mailboxFolderChoices(organisation, id);
  const mailboxes = await withOrganisation(request, body.organisationId, "viewer", (tx) => chooseMailboxFolders(tx, id, body.folders, available));
  return json({ mailboxes });
});
