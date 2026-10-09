import { json, readJson, route, withCrm } from "@/lib/api/http";
import { feedMailFolders } from "@/lib/bank/file-feeds";

/** The folders or labels a lead mailbox can read: as the bills inbox's (BI2). Nothing is saved. Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await withCrm(request, body.organisationId, "admin", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
  }));
  return json({ folders: await feedMailFolders(organisation, actor, body) });
});
