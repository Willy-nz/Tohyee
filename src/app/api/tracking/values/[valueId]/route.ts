import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateTrackingValue } from "@/lib/tracking/service";

type Context = { params: Promise<{ valueId: string }> };

/** Renames a value, moves it (`parentId`, null for the top), or archives or restores it (`isActive`). */
export const PATCH = route<Context>(async (request, context) => {
  const { valueId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateTrackingValue(tx, valueId, { name: body.name, parentId: body.parentId, isActive: body.isActive }),
  );
  return json(setup);
});
