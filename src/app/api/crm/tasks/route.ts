import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createTask, listTasks } from "@/lib/crm/service";

/** Tasks, optionally open ones, one assignee's, or about one company (example CRM6). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const tasks = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listTasks(tx, {
      contactId: params.get("contactId"),
      opportunityId: params.get("opportunityId"),
      open: params.get("open") === "true",
      assigneeUserId: params.get("assigneeUserId"),
    }),
  );
  return json({ tasks });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const task = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createTask(tx, {
      title: body.title,
      body: body.body,
      dueDate: body.dueDate,
      status: body.status,
      assigneeUserId: body.assigneeUserId,
      contactId: body.contactId,
      personId: body.personId,
      opportunityId: body.opportunityId,
    }),
  );
  return json({ task }, { status: 201 });
});
