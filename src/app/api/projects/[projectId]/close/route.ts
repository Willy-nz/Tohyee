import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { closeProject } from "@/lib/projects/service";

type Context = { params: Promise<{ projectId: string }> };

/** Closes the project; refused while anything is unbilled unless `writeOff` is true (PJ10). */
export const POST = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const project = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => closeProject(tx, projectId, { writeOff: body.writeOff }));
  return json({ project });
});
