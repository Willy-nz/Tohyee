import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getProject, updateProject } from "@/lib/projects/service";

type Context = { params: Promise<{ projectId: string }> };

/** GET: the project with its tasks, time, expenses, invoices and figures. */
export const GET = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const project = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getProject(tx, projectId));
  return json({ project });
});

/** Changes the name, customer (before any invoice), estimate or deadline. The status only changes by closing or reopening. */
export const PUT = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const project = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateProject(tx, projectId, { name: body.name, contactId: body.contactId, estimate: body.estimate, deadline: body.deadline }),
  );
  return json({ project });
});
