import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addGrazing, listGrazings, openGrazings } from "@/lib/farming/pasture";

type Context = { params: Promise<{ farmId: string }> };

/** GET: a page of the farm's grazings, newest first (`paddockId`, `from`, `to`, `limit`, `cursor`; `next` is the next page's cursor). `open=1` lists only mobs still in. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  if (params.get("open") === "1") {
    const grazings = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => openGrazings(tx, { farmId }));
    return json({ grazings, next: null });
  }
  const page = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listGrazings(tx, { farmId, paddockId: params.get("paddockId"), from: params.get("from"), to: params.get("to"), limit: params.get("limit"), cursor: params.get("cursor") }));
  return json({ grazings: page.rows, next: page.next });
});

/** Records a grazing (`paddockId`, `mob`, `head`, `inOn`, `outOn`, `preCover`, `postCover`, `note`). Bookkeepers and above (PF5). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const grazing = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addGrazing(tx, { farmId, paddockId: body.paddockId, mob: body.mob, head: body.head, inOn: body.inOn, outOn: body.outOn, preCover: body.preCover, postCover: body.postCover, note: body.note }),
  );
  return json({ grazing }, { status: 201 });
});
