import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listSyncLog } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ connectionId: string }> };

/** The connection's sync log, newest first (viewers can read it). */
export const GET = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const params = searchParams(request);
  const { entries } = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listSyncLog(tx, connectionId, { beforeId: params.get("beforeId") }),
  );
  return json({ entries });
});
