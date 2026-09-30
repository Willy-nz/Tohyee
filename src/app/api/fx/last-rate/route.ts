import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { parseIsoDate } from "@/lib/dates";
import { lastRateFor } from "@/lib/ledger/foreign";
import { parseCurrencyCode } from "@/lib/money/currency";

/**
 * GET: the last rate used for a currency on or before a date (D4), which a
 * foreign-currency invoice, bill, credit note or payment starts with (MC3),
 * or null when none has been used yet.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const rate = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    lastRateFor(tx, parseCurrencyCode(params.get("currencyCode")), parseIsoDate(params.get("date"), "date")),
  );
  return json({ rate });
});
