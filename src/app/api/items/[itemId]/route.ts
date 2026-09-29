import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getItem, updateItem } from "@/lib/items/service";

type Context = { params: Promise<{ itemId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const item = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getItem(tx, itemId));
  return json({ item });
});

/** Changes an item, or archives or restores it (`isActive`). Lists sent replace the whole list (IT1, IT4, IT6, IT7). */
export const PATCH = route<Context>(async (request, context) => {
  const { itemId } = await context.params;
  const body = await readJson(request);
  const item = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateItem(tx, itemId, {
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
      saleUnitId: body.saleUnitId,
      purchaseUnitId: body.purchaseUnitId,
      isActive: body.isActive,
      levelPrices: body.levelPrices,
      suppliers: body.suppliers,
      components: body.components,
    }),
  );
  return json({ item });
});
