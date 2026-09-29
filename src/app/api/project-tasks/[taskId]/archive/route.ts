import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { archiveTask } from "@/lib/projects/service";

type Context = { params: Promise<{ taskId: string }> };

/** Archives a task (tasks are never deleted). */
export const POST = route<Context>(async (request, context) => {
  const { taskId } = await context.params;
  const body = await readJson(request);
  const project = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => archiveTask(tx, taskId));
  return json({ project });
});
