import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { MailOwner } from "@/lib/private-mail/access";
import { chooseMyFolders, myFolderChoices, ownAccount } from "@/lib/private-mail/store";

type Context = { params: Promise<{ mailboxId: string }> };

/** GET ?organisationId=: the mailbox's folders or labels to tick, from the mailbox now (PM2). The Owner's own only. */
export const GET = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const { organisation, id } = await withOrganisation(request, searchParams(request).get("organisationId"), "sales_rep", async (tx, { membership }) => ({
    organisation: membership.organisation,
    id: await ownAccount(tx, await MailOwner.of(tx), mailboxId),
  }));
  return json({ folders: await myFolderChoices(organisation, id) });
});

/** PUT: the folders to read, the one choice the farm calendar uses too (PM2, PM6). Body: { organisationId, folders: [{ id, includeSubfolders }] }. */
export const PUT = route<Context>(async (request, context) => {
  const { mailboxId } = await context.params;
  const body = await readJson(request);
  const { organisation, id } = await withOrganisation(request, body.organisationId, "sales_rep", async (tx, { membership }) => ({
    organisation: membership.organisation,
    id: await ownAccount(tx, await MailOwner.of(tx), mailboxId),
  }));
  const available = await myFolderChoices(organisation, id);
  const result = await withOrganisation(request, body.organisationId, "sales_rep", async (tx) => chooseMyFolders(tx, await MailOwner.of(tx), id, body.folders, available));
  return json(result);
});
