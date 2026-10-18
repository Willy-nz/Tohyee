import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeSoilSample } from "@/lib/farming/soil-samples";

type Context = { params: Promise<{ sampleId: string }> };

/** Removes a soil sample recorded by mistake; it's kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { sampleId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeSoilSample(tx, sampleId));
  return json({ ok: true });
});
