import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createTaxCode, listTaxCodes } from "@/lib/tax/codes";

export const GET = route(async (request) => {
  const taxCodes = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    listTaxCodes(tx),
  );
  return json({ taxCodes });
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
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
