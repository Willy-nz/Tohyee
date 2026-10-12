import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addMaterial, listMaterials } from "@/lib/projects/jobs";

type Context = { params: Promise<{ projectId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const materials = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listMaterials(tx, projectId));
  return json({ materials });
});

/** Records materials used on a job (JV4), at the item's sale price unless `unitPrice` is given. Stock goes out when invoiced. */
export const POST = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const materials = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addMaterial(tx, projectId, { itemId: body.itemId, quantity: body.quantity, unitPrice: body.unitPrice, visitId: body.visitId }),
  );
  return json({ materials }, { status: 201 });
});
