import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { acceptImportRow } from "@/lib/tax/income/ird-imports";

type Context = { params: Promise<{ rowId: string }> };

/** POST: a person accepts an imported IRD row (optional `useAsAssessedRit` with `returnFiledOn`, or `asNewPayment`). Owners and admins (ITX-IMP6 to ITX-IMP9). */
export const POST = route<Context>(async (request, context) => {
  const { rowId } = await context.params;
  const body = await readJson(request);
  const row = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    acceptImportRow(tx, rowId, { useAsAssessedRit: body.useAsAssessedRit, returnFiledOn: body.returnFiledOn, asNewPayment: body.asNewPayment }),
  );
  return json({ row });
});
