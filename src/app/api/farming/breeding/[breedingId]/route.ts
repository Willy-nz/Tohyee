import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeBreeding } from "@/lib/farming/planning";

type Context = { params: Promise<{ breedingId: string }> };

/** Removes a breeding record entered by mistake; it's kept, marked removed. Bookkeepers and up. */
export const DELETE = route<Context>(async (request, context) => {
  const { breedingId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeBreeding(tx, breedingId));
  return json({ ok: true });
});
