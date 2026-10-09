import { json, readJson, route, withCrm } from "@/lib/api/http";
import { updateTask } from "@/lib/crm/service";

type Context = { params: Promise<{ taskId: string }> };

/** Changes a task, e.g. marks it done (example CRM6). */
export const PATCH = route<Context>(async (request, context) => {
  const { taskId } = await context.params;
  const body = await readJson(request);
  const task = await withCrm(request, body.organisationId, "write", (tx, { scope }) =>
    updateTask(tx, taskId, {
      title: body.title,
      body: body.body,
      dueDate: body.dueDate,
      status: body.status,
      assigneeUserId: body.assigneeUserId,
      contactId: body.contactId,
      personId: body.personId,
      opportunityId: body.opportunityId,
      leadId: body.leadId,
    }, scope),
  );
  return json({ task });
});
