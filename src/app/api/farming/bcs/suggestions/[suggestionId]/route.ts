import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { acceptSuggestion, declineSuggestion } from "@/lib/farming/bcs";

type Context = { params: Promise<{ suggestionId: string }> };

/** POST `{ action: "accept", score?, acceptWeight?, kg? }` or `{ action: "decline", reason? }` for an AI's BCS suggestion (decision 1492). */
export const POST = route<Context>(async (request, context) => {
  const { suggestionId } = await context.params;
  const body = await readJson(request);
  const suggestion = await withFarmWork(request, body.organisationId, "record", (tx) => {
    if (body.action === "accept") return acceptSuggestion(tx, suggestionId, { score: body.score, acceptWeight: body.acceptWeight, kg: body.kg });
    if (body.action === "decline") return declineSuggestion(tx, suggestionId, { reason: body.reason });
    throw new ValidationError("action must be accept or decline.");
  });
  return json({ suggestion });
});
