import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { assertFeedOnAccount, deleteFileFeed, updateFileFeed } from "@/lib/bank/file-feeds";

type Context = { params: Promise<{ accountId: string; feedId: string }> };

/** Changes how often the feed is checked (`syncEveryHours`, 1-24). Admins. */
export const PATCH = route<Context>(async (request, context) => {
  const { accountId, feedId } = await context.params;
  const body = await readJson(request);
  const feed = await withOrganisation(request, body.organisationId, "admin", async (tx) => {
    await assertFeedOnAccount(tx, accountId, feedId);
    return updateFileFeed(tx, feedId, body);
  });
  return json({ feed });
});

/** Removes the feed. Its imports stay, and so does what it had read (BF10). Admins. */
export const DELETE = route<Context>(async (request, context) => {
  const { accountId, feedId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", async (tx) => {
    await assertFeedOnAccount(tx, accountId, feedId);
    await deleteFileFeed(tx, feedId);
  });
  return json({ deleted: true });
});
