import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { feedMailFolders } from "@/lib/bank/file-feeds";

/**
 * The folders or labels a mailbox feed can read (admins): `mailKind` "crm"
 * with `mailAccountId` (your own connected mailbox), or "imap" with
 * `imapHost`, `imapUsername` and `imapPassword`. Nothing is saved.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ folders: await feedMailFolders(organisation, actor, body) });
});
