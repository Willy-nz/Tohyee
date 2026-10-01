import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteCustomFieldSection, updateCustomFieldSection } from "@/lib/custom-fields/service";

type Context = { params: Promise<{ sectionId: string }> };

/** Renames a section or moves it (`move`: "up" or "down") (example CRMF6). Admins only. */
export const PATCH = route<Context>(async (request, context) => {
  const { sectionId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateCustomFieldSection(tx, sectionId, { name: body.name, move: body.move }),
  );
  return json(setup);
});

/** Removes a section that has no fields (example CRMF6). Admins only. */
export const DELETE = route<Context>(async (request, context) => {
  const { sectionId } = await context.params;
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => deleteCustomFieldSection(tx, sectionId));
  return json(setup);
});
