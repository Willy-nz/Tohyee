import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { acceptLivestockSuggestion, declineLivestockSuggestion } from "@/lib/livestock/suggestions";

type Context = { params: Promise<{ suggestionId: string }> };

/**
 * Accepts (`decision: "accept"`, with `idempotencyKey` and optional `changes`
 * such as a location) or declines (`decision: "decline"`) a suggested
 * movement. Accepting records it with every check. Bookkeepers.
 */
export const POST = route<Context>(async (request, context) => {
  const { suggestionId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) =>
    body.decision === "accept"
      ? acceptLivestockSuggestion(tx, suggestionId, { idempotencyKey: body.idempotencyKey, changes: body.changes })
      : { suggestion: await declineLivestockSuggestion(tx, suggestionId) },
  );
  return json(result);
});
