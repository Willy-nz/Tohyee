import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addCustomFieldOption } from "@/lib/custom-fields/service";

type Context = { params: Promise<{ fieldId: string }> };

/** Adds an option to a list or multiple select field. */
export const POST = route<Context>(async (request, context) => {
  const { fieldId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) => addCustomFieldOption(tx, fieldId, { name: body.name }));
  return json(setup, { status: 201 });
});
