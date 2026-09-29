import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateTask } from "@/lib/projects/service";

type Context = { params: Promise<{ taskId: string }> };

/** Changes a task (PJ2). Its charge type and a fixed price don't change once something of it is invoiced. */
export const PUT = route<Context>(async (request, context) => {
  const { taskId } = await context.params;
  const body = await readJson(request);
  const project = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateTask(tx, taskId, { name: body.name, chargeType: body.chargeType, rate: body.rate, estimateHours: body.estimateHours, estimateMinutes: body.estimateMinutes }),
  );
  return json({ project });
});
