import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { parseIsoDate } from "@/lib/dates";
import { openCurrencyBalances } from "@/lib/ledger/fx-revaluation";

/**
 * GET: open foreign-currency invoices, bills and credit notes on accounts
 * receivable and payable as at `asAt`, one row per account and currency
 * (MC8), for the FX revaluation screen.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const balances = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    openCurrencyBalances(tx, parseIsoDate(params.get("asAt"), "asAt")),
  );
  return json({ balances });
});
