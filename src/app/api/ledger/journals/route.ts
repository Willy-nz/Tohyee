import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listJournals, postJournal } from "@/lib/ledger/journals";

/**
 * GET: newest first, 50 at a time. Filters: postingDateFrom, postingDateTo,
 * referenceQuery, kind (primary|reversal|replacement|manual|inventory|fx_revaluation|invoice|customer_payment|bill|supplier_payment|sales_credit_note|sales_credit_note_refund|supplier_credit_note|supplier_credit_note_refund|customer_overpayment_refund|bank_transaction|bank_transfer),
 * beforeId (for the next page), limit (max 200). Or page (from 1) and pageSize
 * (default 100, max 200), which also give page, pages and total (decision 1564).
 * kind=journals is manual journals and their replacements, without reversals.
 * hideVoided=1 leaves out voided or corrected journals and their reversals (VP1).
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
      page: params.get("page") ?? undefined,
      pageSize: params.get("pageSize") ?? undefined,
      hideVoided: params.get("hideVoided") ?? undefined,
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
      customFields: body.customFields,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
