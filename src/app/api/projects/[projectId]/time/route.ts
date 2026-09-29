import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createTimeEntry } from "@/lib/projects/service";

type Context = { params: Promise<{ projectId: string }> };

/** Records time (PJ3): your own, or an admin's for another member (`userId`). */
export const POST = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    createTimeEntry(tx, membership.role, projectId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      userId: body.userId,
      taskId: body.taskId,
      entryDate: body.entryDate,
      hours: body.hours,
      minutes: body.minutes,
      description: body.description,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
