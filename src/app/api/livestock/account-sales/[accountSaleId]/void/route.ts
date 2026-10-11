import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidAccountSale } from "@/lib/livestock/account-sales";

type Context = { params: Promise<{ accountSaleId: string }> };

/** Voids an account sale and everything it made, with a reason (LV16). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { accountSaleId } = await context.params;
  const body = await readJson(request);
  const accountSale = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => voidAccountSale(tx, accountSaleId, { reason: body.reason, voidDate: body.voidDate }));
  return json({ accountSale });
});
