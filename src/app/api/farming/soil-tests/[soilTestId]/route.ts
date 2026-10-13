import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeSoilTest } from "@/lib/farming/soil";

type Context = { params: Promise<{ soilTestId: string }> };

/** Removes a soil test entered or imported by mistake; it's kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { soilTestId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeSoilTest(tx, soilTestId));
  return json({ ok: true });
});
