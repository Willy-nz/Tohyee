import { json, readJson, route, searchParams, withCrm, withOrganisation } from "@/lib/api/http";
import { createCustomField, getCustomFieldSetup } from "@/lib/custom-fields/service";

/**
 * GET: whether advanced features and the CRM are on, the sections, and every
 * custom field with its options (examples CF1-CF10, CRMF1-CRMF9). Viewers and
 * up, and sales roles, whose CRM pages show the fields (decision 491).
 */
export const GET = route(async (request) => {
  const setup = await withCrm(request, searchParams(request).get("organisationId"), "read", (tx) => getCustomFieldSetup(tx));
  return json(setup);
});

/** Adds a custom field (examples CF1, CRMF2). Admins only. */
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
      sectionId: body.sectionId,
    }),
  );
  return json(setup, { status: 201 });
});
