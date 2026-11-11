import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { planVoidJournals, voidJournals } from "@/lib/ledger/void-journals";

/**
 * POST: voids posted manual journals (VJ1-VJ5). Without `previewHash` it's
 * the preview (each journal, whether it can be voided, the effect by
 * account); with it, the voids (`journalIds`, optional `voidDate`, `reason`,
 * `idempotencyKey`). Bookkeepers.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx): Promise<unknown> =>
    body.previewHash
      ? voidJournals(tx, { journalIds: body.journalIds, voidDate: body.voidDate, reason: body.reason, previewHash: body.previewHash, idempotencyKey: body.idempotencyKey })
      : planVoidJournals(tx, { journalIds: body.journalIds, voidDate: body.voidDate }),
  );
  return json(result);
});
