import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { closeGrazing, removeGrazing } from "@/lib/farming/pasture";

type Context = { params: Promise<{ grazingId: string }> };

/** PATCH: the day out (`outOn`) and optionally the cover after (`postCover`) for a mob still in. */
export const PATCH = route<Context>(async (request, context) => {
  const { grazingId } = await context.params;
  const body = await readJson(request);
  const grazing = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => closeGrazing(tx, grazingId, { outOn: body.outOn, postCover: body.postCover }));
  return json({ grazing });
});

/** Removes a grazing recorded by mistake; it's kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { grazingId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeGrazing(tx, grazingId));
  return json({ ok: true });
});
