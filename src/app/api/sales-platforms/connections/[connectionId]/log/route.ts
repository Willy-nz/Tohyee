import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listSyncLog } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ connectionId: string }> };

/**
 * The connection's sync log, newest first, 200 lines a page (viewers can
 * read it). `beforeId` continues from the oldest line shown; `kind`
 * (customers, products, orders, payouts, connection) and `outcome`
 * (problems, skipped, failed, waiting, posted, brought_in) filter it.
 */
export const GET = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const params = searchParams(request);
  const { entries, hasMore } = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listSyncLog(tx, connectionId, { beforeId: params.get("beforeId"), kind: params.get("kind"), outcome: params.get("outcome") }),
  );
  return json({ entries, hasMore });
});
