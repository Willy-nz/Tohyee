import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getStatementLine } from "@/lib/bank/accounts";
import { suggestionsForLine } from "@/lib/bank/reconcile";

type Context = { params: Promise<{ lineId: string }> };

/** GET: a statement line, and what it could be reconciled with (matching transactions, invoices or bills, a bank rule). */
export const GET = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => ({
    line: await getStatementLine(tx, lineId),
    suggestions: await suggestionsForLine(tx, lineId),
  }));
  return json(result);
});
