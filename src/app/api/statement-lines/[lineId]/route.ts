import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getStatementLine } from "@/lib/bank/accounts";
import { suggestionsForLine } from "@/lib/bank/reconcile";

type Context = { params: Promise<{ lineId: string }> };

/** GET: a statement line, and what it could be reconciled with (matching transactions, invoices or bills, a bank rule). */
export const GET = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => ({
    line: await getStatementLine(tx, lineId),
    // Voided transactions and their reversals only when asked for (#571).
    suggestions: await suggestionsForLine(tx, lineId, undefined, { includeVoided: params.get("includeVoided") === "1" }),
  }));
  return json(result);
});
