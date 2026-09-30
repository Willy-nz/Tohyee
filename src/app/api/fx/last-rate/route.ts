import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { parseIsoDate } from "@/lib/dates";
import { lastRateFor } from "@/lib/ledger/foreign";
import { parseCurrencyCode } from "@/lib/money/currency";

/**
 * GET: the rate a foreign-currency invoice, bill, credit note or payment
 * starts with: the exchange rates list's rate effective on the date (MC48),
 * else the last rate used on or before it (D4, MC3), or null when neither.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const rate = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    lastRateFor(tx, parseCurrencyCode(params.get("currencyCode")), parseIsoDate(params.get("date"), "date")),
  );
  return json({ rate });
});
