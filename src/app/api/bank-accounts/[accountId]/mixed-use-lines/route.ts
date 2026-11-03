import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listReviewLines } from "@/lib/bank/mixed-use";

type Context = { params: Promise<{ accountId: string }> };

/** GET: a mixed-use or personal account's lines with their reviews (#545). `state`: to_review (default), reviewed, excluded or all. */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listReviewLines(tx, accountId, { state: params.get("state"), limit: params.get("limit"), search: params.get("search") }),
  );
  return json(result);
});
