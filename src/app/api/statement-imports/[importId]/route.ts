import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteImport } from "@/lib/bank/imports";

type Context = { params: Promise<{ importId: string }> };

/** Deletes an import: its lines are marked deleted. Refused while any of them is reconciled. */
export const DELETE = route<Context>(async (request, context) => {
  const { importId } = await context.params;
  const deleted = await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) =>
    deleteImport(tx, importId),
  );
  return json({ import: deleted });
});
