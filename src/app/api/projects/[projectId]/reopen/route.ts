import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { reopenProject } from "@/lib/projects/service";

type Context = { params: Promise<{ projectId: string }> };

/** Reopens a closed project (PJ10). Anything written off stays written off. */
export const POST = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const project = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => reopenProject(tx, projectId));
  return json({ project });
});
