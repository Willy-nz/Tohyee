import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { acceptEstimate, compareEstimate, declineEstimate } from "@/lib/farming/pasture-photos";

type Context = { params: Promise<{ estimateId: string }> };

/** POST: a person decides an AI's photo estimate: `action` "accept" (with `cover` to change it first), "compare" or "decline" (with an optional `reason`). Like recording a reading (decision 1165). */
export const POST = route<Context>(async (request, context) => {
  const { estimateId } = await context.params;
  const body = await readJson(request);
  const estimate = await withFarmWork(request, body.organisationId, "record", (tx) => {
    if (body.action === "accept") return acceptEstimate(tx, estimateId, { cover: body.cover });
    if (body.action === "compare") return compareEstimate(tx, estimateId);
    if (body.action === "decline") return declineEstimate(tx, estimateId, { reason: body.reason });
    throw new ValidationError("action must be accept, compare or decline.");
  });
  return json({ estimate });
});
