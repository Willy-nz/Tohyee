import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createTask } from "@/lib/projects/service";

type Context = { params: Promise<{ projectId: string }> };

/** Adds a task: hourly (rate), fixed price or non-chargeable, with an optional estimate (PJ2). */
export const POST = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createTask(tx, projectId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      name: body.name,
      chargeType: body.chargeType,
      rate: body.rate,
      estimateHours: body.estimateHours,
      estimateMinutes: body.estimateMinutes,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
