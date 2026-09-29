import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createItem, listItems } from "@/lib/items/service";

/** Products and services (examples IT1-IT9). `includeArchived=true` also returns archived items; `search` matches code or name. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listItems(tx, { includeArchived: params.get("includeArchived"), search: params.get("search") }),
  );
  return json(result);
});

/** Adds an item (IT1). Bookkeepers and up. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createItem(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      code: body.code,
      name: body.name,
      description: body.description,
      itemType: body.itemType,
      baseUnit: body.baseUnit,
      salePrice: body.salePrice,
      purchasePrice: body.purchasePrice,
      incomeAccountCode: body.incomeAccountCode,
      purchaseAccountCode: body.purchaseAccountCode,
      salesTaxCode: body.salesTaxCode,
      purchaseTaxCode: body.purchaseTaxCode,
      isActive: body.isActive,
      levelPrices: body.levelPrices,
      suppliers: body.suppliers,
      components: body.components,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
