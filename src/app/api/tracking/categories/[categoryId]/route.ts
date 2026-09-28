import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateTrackingCategory } from "@/lib/tracking/service";

type Context = { params: Promise<{ categoryId: string }> };

/** Renames a tracking category, makes it required (TC6), or archives or restores a custom segment (CS2). */
export const PATCH = route<Context>(async (request, context) => {
  const { categoryId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateTrackingCategory(tx, categoryId, { name: body.name, isRequired: body.isRequired, isActive: body.isActive }),
  );
  return json(setup);
});
