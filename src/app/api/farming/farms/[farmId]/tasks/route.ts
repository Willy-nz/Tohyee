import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { addTask, listTasks } from "@/lib/farming/tasks";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's tasks: to do by when they're next due (default), or `view=done` (finished one-offs) or `view=cancelled`; `mine=1` for the person's own. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const tasks = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listTasks(tx, { farmId, view: params.get("view"), mine: params.get("mine") === "1" }));
  return json({ tasks });
});

/** Adds a task (`title`, `dueOn`, and optionally `assignedToUserId`, `repeat`, `paddockId`, `point` [longitude, latitude], `note`). Farm staff and up (FT1). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const task = await withFarmWork(request, body.organisationId, "record", (tx) =>
    addTask(tx, { farmId, title: body.title, dueOn: body.dueOn, assignedToUserId: body.assignedToUserId, repeat: body.repeat, paddockId: body.paddockId, point: body.point, note: body.note }),
  );
  return json({ task }, { status: 201 });
});
