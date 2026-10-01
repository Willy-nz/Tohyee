import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createCustomFieldSection } from "@/lib/custom-fields/service";

/** Adds a section of custom fields for contacts, documents, people or opportunities (example CRMF6). Admins only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createCustomFieldSection(tx, { record: body.record, name: body.name }),
  );
  return json(setup, { status: 201 });
});
