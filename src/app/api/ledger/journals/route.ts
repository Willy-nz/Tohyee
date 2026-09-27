import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listJournals, postJournal } from "@/lib/ledger/journals";

/**
 * GET: newest first, 50 at a time. Filters: postingDateFrom, postingDateTo,
 * referenceQuery, kind (primary|reversal|replacement|manual|inventory|fx_revaluation|invoice|customer_payment|bill|supplier_payment),
 * beforeId (for the next page), limit (max 200).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listJournals(tx, {
      postingDateFrom: params.get("postingDateFrom"),
      postingDateTo: params.get("postingDateTo"),
      referenceQuery: params.get("referenceQuery"),
      kind: params.get("kind") ?? params.get("correctionKind"),
      beforeId: params.get("beforeId"),
      limit: params.get("limit") ?? undefined,
    }),
  );
  return json(result);
});

/** Posts a manual journal. Retrying with the same idempotencyKey is safe. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    postJournal(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      postingDate: body.postingDate,
      reference: body.reference,
      description: body.description,
      currencyCode: body.currencyCode,
      lines: body.lines,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
