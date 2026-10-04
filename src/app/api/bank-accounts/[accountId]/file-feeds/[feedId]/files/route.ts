import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { assertFeedOnAccount, feedFiles } from "@/lib/bank/file-feeds";

type Context = { params: Promise<{ accountId: string; feedId: string }> };

/** The files the feed has read, newest first, with what happened to each. */
export const GET = route<Context>(async (request, context) => {
  const { accountId, feedId } = await context.params;
  const files = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    await assertFeedOnAccount(tx, accountId, feedId);
    return feedFiles(tx, feedId);
  });
  return json({ files });
});
