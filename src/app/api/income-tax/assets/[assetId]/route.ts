import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setTaxDetails } from "@/lib/tax/income/assets";

type Context = { params: Promise<{ assetId: string }> };

/** PUT: a fixed asset's tax details (owners and admins; ITX11-ITX17). Nothing posts. */
export const PUT = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const asset = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    setTaxDetails(tx, assetId, {
      method: body.method,
      rate: body.rate,
      taxCost: body.taxCost,
      businessUsePercent: body.businessUsePercent,
      availableOn: body.availableOn,
      newAsset: body.newAsset,
      investmentBoost: body.investmentBoost,
      openingIncomeYear: body.openingIncomeYear,
      openingAtv: body.openingAtv,
      version: body.version,
    }),
  );
  return json({ asset });
});
