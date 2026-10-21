import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { acceptImportRows } from "@/lib/tax/income/ird-imports";

/** POST: a person accepts several imported IRD rows at once (`rowIds`); none is saved as the assessed RIT this way. Owners and admins (ITX-IMP6). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const rows = await withOrganisation(request, body.organisationId, "admin", (tx) => acceptImportRows(tx, { rowIds: body.rowIds }));
  return json({ rows });
});
