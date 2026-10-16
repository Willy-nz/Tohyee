import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeIcaEntry } from "@/lib/tax/income/ica";

type Context = { params: Promise<{ entryId: string }> };

/** DELETE: removes a typed imputation credit account entry; the history keeps it (owners and admins). */
export const DELETE = route<Context>(async (request, context) => {
  const { entryId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => removeIcaEntry(tx, entryId));
  return json({ removed: true });
});
