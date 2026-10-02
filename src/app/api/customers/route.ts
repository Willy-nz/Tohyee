import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getCustomerSetup, setCreditLimitAction, setDefaultPaymentTerms } from "@/lib/customers/service";

/** Payment terms, customer groups, price levels and the credit limit setting (examples RC1-RC12). */
export const GET = route(async (request) => {
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getCustomerSetup(tx));
  return json(setup);
});

/**
 * Sets what happens over a credit limit: `creditLimitAction` "warn" or "block" (RC3, RC4); and/or
 * the organisation's default terms, `defaultSalesPaymentTermId` and `defaultBillPaymentTermId`
 * (decision 333; blank clears). Admins only.
 */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", async (tx) => {
    if (body.defaultSalesPaymentTermId !== undefined || body.defaultBillPaymentTermId !== undefined) {
      await setDefaultPaymentTerms(tx, body);
    }
    return body.creditLimitAction !== undefined ? setCreditLimitAction(tx, body.creditLimitAction) : getCustomerSetup(tx);
  });
  return json(setup);
});
