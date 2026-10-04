import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { assertFeedOnAccount, checkFileFeed, listFileFeeds } from "@/lib/bank/file-feeds";

type Context = { params: Promise<{ accountId: string; feedId: string }> };

/** Checks the feed now (Check now): reads any new statement files, outside a long transaction. */
export const POST = route<Context>(async (request, context) => {
  const { accountId, feedId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx, { auth, membership }) => {
    await assertFeedOnAccount(tx, accountId, feedId);
    return { organisation: membership.organisation, actor: { userId: auth.user.id, email: auth.user.email } };
  });
  const check = await checkFileFeed(organisation, actor, feedId);
  const feeds = await withOrganisation(request, body.organisationId, "viewer", (tx) => listFileFeeds(tx, accountId));
  return json({ check, feeds });
});
