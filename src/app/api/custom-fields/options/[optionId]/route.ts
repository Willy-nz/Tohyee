import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateCustomFieldOption } from "@/lib/custom-fields/service";

type Context = { params: Promise<{ optionId: string }> };

/** Renames an option, or archives or restores it (`isActive`, example CF7). */
export const PATCH = route<Context>(async (request, context) => {
  const { optionId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateCustomFieldOption(tx, optionId, { name: body.name, isActive: body.isActive }),
  );
  return json(setup);
});
