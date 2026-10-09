import { json, readJson, route, withCrm } from "@/lib/api/http";
import { updateStage } from "@/lib/crm/stages";

type Context = { params: Promise<{ stageId: string }> };

/** Renames, retypes, re-weights, archives, restores or moves a stage (CRMS2, CRMS3). Admins and owners only. */
export const PATCH = route<Context>(async (request, context) => {
  const { stageId } = await context.params;
  const body = await readJson(request);
  const stage = await withCrm(request, body.organisationId, "admin", (tx) =>
    updateStage(tx, stageId, {
      name: body.name,
      type: body.type,
      probability: body.probability,
      forecastCategory: body.forecastCategory,
      isActive: body.isActive,
      move: body.move,
    }),
  );
  return json({ stage });
});
