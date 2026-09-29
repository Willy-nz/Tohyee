import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createCustomerGroup } from "@/lib/customers/service";

/** Adds a customer group (example RC7). Admins only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) => createCustomerGroup(tx, { name: body.name }));
  return json(setup, { status: 201 });
});
