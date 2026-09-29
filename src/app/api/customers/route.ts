import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getCustomerSetup, setCreditLimitAction } from "@/lib/customers/service";

/** Payment terms, customer groups, price levels and the credit limit setting (examples RC1-RC12). */
export const GET = route(async (request) => {
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getCustomerSetup(tx));
  return json(setup);
});

/** Sets what happens over a credit limit: `creditLimitAction` "warn" or "block" (RC3, RC4). Admins only. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) => setCreditLimitAction(tx, body.creditLimitAction));
  return json(setup);
});
