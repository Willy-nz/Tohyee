import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateTrackingCategory } from "@/lib/tracking/service";

type Context = { params: Promise<{ categoryId: string }> };

/** Renames a tracking category or makes it required (example TC6). */
export const PATCH = route<Context>(async (request, context) => {
  const { categoryId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateTrackingCategory(tx, categoryId, { name: body.name, isRequired: body.isRequired }),
  );
  return json(setup);
});
