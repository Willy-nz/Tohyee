import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateCustomerGroup } from "@/lib/customers/service";

type Context = { params: Promise<{ groupId: string }> };

/** Renames a customer group, or archives or restores it (`isActive`, example RC7). */
export const PATCH = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateCustomerGroup(tx, groupId, { name: body.name, isActive: body.isActive }),
  );
  return json(setup);
});
