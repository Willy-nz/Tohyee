import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createTaxCode, listTaxCodes } from "@/lib/tax/codes";
import { getGstRegistration } from "@/lib/tax/registration";

export const GET = route(async (request) => {
  const { taxCodes, gstRegistration } = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    const registration = await getGstRegistration(tx);
    return {
      taxCodes: await listTaxCodes(tx),
      // So document screens can offer only no-GST codes while not registered (issue #180, NR1-NR2).
      gstRegistration: { registered: registration.registered, from: registration.from, until: registration.until },
    };
  });
  return json({ taxCodes, gstRegistration });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    createTaxCode(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      code: body.code,
      label: body.label,
      category: body.category,
      rate: body.rate,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo,
      availableOn: body.availableOn,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
