import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { archiveExchangeRate } from "@/lib/fx/rates";

type Context = { params: Promise<{ exchangeRateId: string }> };

/** Archives an entry in the exchange rates list (MC47); it's kept, never deleted. */
export const POST = route<Context>(async (request, context) => {
  const { exchangeRateId } = await context.params;
  const body = await readJson(request);
  const rate = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => archiveExchangeRate(tx, exchangeRateId));
  return json({ rate });
});
