import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createProject, listProjects } from "@/lib/projects/service";

/** GET: projects with their figures, newest first; `status` (in_progress, closed) and `contactId` filter them (PJ1). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const projects = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listProjects(tx, { status: params.get("status"), contactId: params.get("contactId") }),
  );
  return json({ projects });
});

/** Starts a project for a customer (PJ1). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createProject(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      name: body.name,
      contactId: body.contactId,
      estimate: body.estimate,
      deadline: body.deadline,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
