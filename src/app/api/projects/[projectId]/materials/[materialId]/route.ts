import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeMaterial } from "@/lib/projects/jobs";

type Context = { params: Promise<{ projectId: string; materialId: string }> };

/** Takes materials off a job before they're invoiced (JV4). */
export const DELETE = route<Context>(async (request, context) => {
  const { materialId } = await context.params;
  const body = await readJson(request);
  const materials = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => removeMaterial(tx, materialId));
  return json({ materials });
});
