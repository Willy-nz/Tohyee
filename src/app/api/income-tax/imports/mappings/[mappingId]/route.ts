import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteIrdMapping } from "@/lib/tax/income/ird-imports";

type Context = { params: Promise<{ mappingId: string }> };

/** DELETE: removes a saved IRD file mapping (ITX-IMP3). Owners and admins. */
export const DELETE = route<Context>(async (request, context) => {
  const { mappingId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => deleteIrdMapping(tx, mappingId));
  return json({ deleted: true });
});
