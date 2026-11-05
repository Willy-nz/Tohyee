import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { updateTask } from "@/lib/farming/tasks";

type Context = { params: Promise<{ taskId: string }> };

/** Changes a task (any of the fields `POST` takes), or cancels it or opens it again (`status`). Farm staff and up (FT2). */
export const PATCH = route<Context>(async (request, context) => {
  const { taskId } = await context.params;
  const body = await readJson(request);
  const { organisationId, ...input } = body;
  const task = await withFarmWork(request, organisationId, "record", (tx) => updateTask(tx, taskId, input));
  return json({ task });
});
