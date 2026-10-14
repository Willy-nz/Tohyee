import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listRecodes, recodeLine } from "@/lib/ledger/recode";

/** Recodes made to a document's lines (`documentType`: invoice, bill or bank_transaction; `documentId`). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const recodes = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listRecodes(tx, { documentType: params.get("documentType"), documentId: params.get("documentId") }),
  );
  return json({ recodes });
});

/**
 * Recodes one posted line (examples RCD1-RCD6): `documentType`, `documentId`,
 * `lineOrder`, then `accountCode` and/or `tracking`, and a `reason`. Posts a
 * correcting journal on the document's date. Bookkeepers.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    recodeLine(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      documentType: body.documentType,
      documentId: body.documentId,
      lineOrder: body.lineOrder,
      accountCode: body.accountCode,
      tracking: body.tracking,
      reason: body.reason,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
