import { MAX_FILE_JSON_BYTES, json, readJson, route, withOrganisation } from "@/lib/api/http";
import { previewIrdImport } from "@/lib/tax/income/ird-imports";

/** POST: what each row of the file would become through this mapping, with any problems (ITX-IMP2). Saves nothing. Owners and admins. */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const preview = await withOrganisation(request, body.organisationId, "admin", (tx) => previewIrdImport(tx, { rows: body.rows, mapping: body.mapping, fileIncomeYear: body.fileIncomeYear }));
  return json({ preview });
});
