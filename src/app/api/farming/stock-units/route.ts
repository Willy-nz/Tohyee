import { json, readJson, route, searchParams, withFarmWork, withOrganisation } from "@/lib/api/http";
import { listStockUnitFactors, setStockUnitFactors } from "@/lib/farming/mobs";
import { STOCK_UNIT_SOURCE } from "@/lib/farming/stock-units";

/** GET: the stock unit factors in use, with Tohyee's default and its source (decision 1424). */
export const GET = route(async (request) => {
  const factors = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => listStockUnitFactors(tx));
  return json({ factors, source: STOCK_UNIT_SOURCE });
});

/** PUT: change factors (`lines`: kind, classCode, factor; a blank factor goes back to the default). Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const factors = await withOrganisation(request, body.organisationId, "admin", (tx) => setStockUnitFactors(tx, { lines: body.lines }));
  return json({ factors, source: STOCK_UNIT_SOURCE });
});
