import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeReading } from "@/lib/farming/pasture";

type Context = { params: Promise<{ readingId: string }> };

/** Removes a cover reading entered or imported by mistake; it's kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { readingId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeReading(tx, readingId));
  return json({ ok: true });
});
