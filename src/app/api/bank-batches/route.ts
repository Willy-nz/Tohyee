import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { accountBatchIds } from "@/lib/bank/batches";
import { batchSummaries, listBatches } from "@/lib/batches/service";

/**
 * GET: the newest bank batches (#547), with their counts: an AI's
 * bulk_reconcile and unmatch_bank_lines, "Unreconcile selected", and undos.
 * With `accountId`, only those that touched that account's lines.
 */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const accountId = query.get("accountId");
  const batches = await withOrganisation(request, query.get("organisationId"), "viewer", async (tx) =>
    accountId ? batchSummaries(tx, await accountBatchIds(tx, accountId)) : listBatches(tx),
  );
  return json({ batches });
});
