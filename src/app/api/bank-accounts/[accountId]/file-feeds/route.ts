import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createFolderFeed, createMailboxFeed, feedSubfolders, listFileFeeds } from "@/lib/bank/file-feeds";

type Context = { params: Promise<{ accountId: string }> };

/** The account's automatic statement file feeds, and the subfolders a folder feed can read (BF9). */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const { feeds, organisationId } = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx, { membership }) => ({
    feeds: await listFileFeeds(tx, accountId),
    organisationId: membership.organisation.id,
  }));
  return json({ feeds, folder: await feedSubfolders(organisationId) });
});

/**
 * Adds a feed (admins): `kind` "folder" with `subfolder`, or "mailbox" with
 * `mailKind` ("crm" and `mailAccountId`, or "imap" and `imapHost`,
 * `imapUsername`, `imapPassword`), `mailFolderId` and `mailFolderName`.
 * `syncEveryHours` is 1-24 (6 when blank).
 */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const feed = await withOrganisation(request, body.organisationId, "admin", (tx, { membership }) =>
    body.kind === "mailbox" ? createMailboxFeed(tx, accountId, body) : createFolderFeed(tx, membership.organisation.id, accountId, body),
  );
  return json({ feed }, { status: 201 });
});
