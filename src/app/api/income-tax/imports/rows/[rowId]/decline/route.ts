import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { declineImportRow } from "@/lib/tax/income/ird-imports";

type Context = { params: Promise<{ rowId: string }> };

/** POST: a person declines an imported IRD row, with a `reason`. Owners and admins (ITX-IMP10). */
export const POST = route<Context>(async (request, context) => {
  const { rowId } = await context.params;
  const body = await readJson(request);
  const row = await withOrganisation(request, body.organisationId, "admin", (tx) => declineImportRow(tx, rowId, { reason: body.reason }));
  return json({ row });
});
