import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listStatementLines } from "@/lib/bank/accounts";

type Context = { params: Promise<{ accountId: string }> };

/** GET: statement lines. Filters: status (unreconciled|reconciled|excluded|deleted|all), search, limit (max 500), offset. */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listStatementLines(tx, accountId, {
      status: params.get("status"),
      search: params.get("search"),
      limit: params.get("limit"),
      offset: params.get("offset"),
    }),
  );
  return json(result);
});
