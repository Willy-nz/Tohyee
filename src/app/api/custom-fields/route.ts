import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createCustomField, getCustomFieldSetup } from "@/lib/custom-fields/service";

/** GET: whether advanced features are on, and every custom field with its options (examples CF1-CF10). */
export const GET = route(async (request) => {
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getCustomFieldSetup(tx));
  return json(setup);
});

/** Adds a custom field (example CF1). Admins only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createCustomField(tx, {
      record: body.record,
      label: body.label,
      type: body.type,
      usedOn: body.usedOn,
      help: body.help,
      isRequired: body.isRequired,
      defaultValue: body.defaultValue,
      showInList: body.showInList,
      options: body.options,
    }),
  );
  return json(setup, { status: 201 });
});
