import { MAX_FILE_JSON_BYTES, json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { importHistory, listHistoryImports } from "@/lib/import/history";

/** General ledger files brought in as history so far (IM22). Admins. */
export const GET = route(async (request) => {
  const imports = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => listHistoryImports(tx));
  return json({ imports });
});

/**
 * Checks (`commit` false) or posts (`commit` true) a general ledger file as
 * history: one journal per date and ID#, all or nothing (IM22-IM28). Admins.
 */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) => importHistory(tx, body, body.commit === true));
  return json({ result }, { status: result.committed ? 201 : 200 });
});
