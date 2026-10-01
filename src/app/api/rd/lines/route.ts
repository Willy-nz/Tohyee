import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listDocumentLines, listUntaggedLines } from "@/lib/rd/tags";

/**
 * GET (viewers and above): with `documentType` (bill, expense_claim,
 * bank_transaction or journal) and `documentId`, that document's lines and
 * their tags; otherwise posted cost lines not tagged yet (`search`, `from`,
 * `to`).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    if (params.get("documentType")) return listDocumentLines(tx, params.get("documentType"), params.get("documentId"));
    return { lines: await listUntaggedLines(tx, { search: params.get("search"), from: params.get("from"), to: params.get("to") }) };
  });
  return json(result);
});
