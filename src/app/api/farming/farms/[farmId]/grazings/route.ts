import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addGrazing, listGrazings } from "@/lib/farming/pasture";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's grazings, newest first (`paddockId` for one paddock). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const grazings = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listGrazings(tx, { farmId, paddockId: params.get("paddockId") }));
  return json({ grazings });
});

/** Records a grazing (`paddockId`, `mob`, `head`, `inOn`, `outOn`, `preCover`, `postCover`, `note`). Bookkeepers and above (PF5). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const grazing = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addGrazing(tx, { paddockId: body.paddockId, mob: body.mob, head: body.head, inOn: body.inOn, outOn: body.outOn, preCover: body.preCover, postCover: body.postCover, note: body.note }),
  );
  return json({ grazing }, { status: 201 });
});
