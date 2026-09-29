import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateItemUnit } from "@/lib/items/service";

type Context = { params: Promise<{ unitId: string }> };

/** Renames a unit or archives it (`isActive`). Its size can't change (IT5). */
export const PATCH = route<Context>(async (request, context) => {
  const { unitId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateItemUnit(tx, unitId, { name: body.name, factor: body.factor, isActive: body.isActive }),
  );
  return json({ item });
});
