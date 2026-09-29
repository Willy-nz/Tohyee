import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addItemUnit } from "@/lib/items/service";

type Context = { params: Promise<{ itemId: string }> };

/** Adds a unit of measure: a fixed multiple of the item's base unit (IT5). */
export const POST = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => addItemUnit(tx, itemId, { name: body.name, factor: body.factor }));
  return json({ item }, { status: 201 });
});
