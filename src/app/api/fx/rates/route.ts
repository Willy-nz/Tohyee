import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addExchangeRates, listExchangeRates } from "@/lib/fx/rates";

/**
 * GET: the currency exchange rates list (examples MC46-MC53), newest
 * effective date first; archived entries too with `includeArchived=true`.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const list = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listExchangeRates(tx, { includeArchived: params.get("includeArchived") === "true" }),
  );
  return json(list);
});

/**
 * Adds rates to the list (MC46, MC52): `rates` ([{ currencyCode,
 * effectiveDate, rate, note }]) or `text` pasted from a spreadsheet, all or
 * nothing. Bookkeepers, admins and owners.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    addExchangeRates(tx, { source: body.source, idempotencyKey: body.idempotencyKey, rates: body.rates, text: body.text }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
