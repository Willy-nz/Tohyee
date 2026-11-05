import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { markTaskDone, taskHistory, undoTaskDone } from "@/lib/farming/tasks";

type Context = { params: Promise<{ taskId: string }> };

/** GET: every time the task was done, newest first, with undone ones marked (FT5). */
export const GET = route<Context>(async (request, context) => {
  const { taskId } = await context.params;
  const history = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => taskHistory(tx, taskId));
  return json({ history });
});

/** Marks the task done for the day it's due (`doneFor`, the day the person saw); sent again, it's kept once. Farm staff and up (FT4). */
export const POST = route<Context>(async (request, context) => {
  const { taskId } = await context.params;
  const body = await readJson(request);
  const task = await withFarmWork(request, body.organisationId, "record", (tx) => markTaskDone(tx, taskId, { doneFor: body.doneFor }));
  return json({ task });
});

/** Undoes the latest done (`doneId`); kept, with who and when. Farm staff and up (FT5). */
export const DELETE = route<Context>(async (request, context) => {
  const { taskId } = await context.params;
  const params = searchParams(request);
  const task = await withFarmWork(request, params.get("organisationId"), "record", (tx) => undoTaskDone(tx, taskId, { doneId: params.get("doneId") }));
  return json({ task });
});
