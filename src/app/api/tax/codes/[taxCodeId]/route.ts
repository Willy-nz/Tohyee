import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateTaxCode } from "@/lib/tax/codes";

/** Changes a tax code's "Available on" (TAO5, TAO10). Admins only; audited. */
export const PATCH = route<{ params: Promise<{ taxCodeId: string }> }>(async (request, context) => {
  const { taxCodeId } = await context.params;
  const body = await readJson(request);
  const taxCode = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateTaxCode(tx, taxCodeId, { availableOn: body.availableOn }),
  );
  return json({ taxCode });
});
