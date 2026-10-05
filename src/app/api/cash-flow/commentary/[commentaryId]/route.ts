import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { acceptForecastCommentary, removeForecastCommentary } from "@/lib/commentary/service";

type Context = { params: Promise<{ commentaryId: string }> };

/** PUT `{ body? }`: accepts a suggestion, as it is or edited. Bookkeepers. */
export const PUT = route<Context>(async (request, context) => {
  const { commentaryId } = await context.params;
  const body = await readJson(request);
  const commentary = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => acceptForecastCommentary(tx, commentaryId, body));
  return json({ commentary });
});

/** DELETE: removes it (kept, with who removed it). Bookkeepers. */
export const DELETE = route<Context>(async (request, context) => {
  const { commentaryId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeForecastCommentary(tx, commentaryId));
  return json({ removed: true });
});
