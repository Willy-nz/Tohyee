import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { dealQuotes, listDealLines, setDealLines } from "@/lib/crm/deal-lines";
import { getOpportunity } from "@/lib/crm/service";

type Context = { params: Promise<{ opportunityId: string }> };

/** A deal's products and the quotes made from it (decision 502). */
export const GET = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { scope }) => {
    const deal = await getOpportunity(tx, opportunityId, scope);
    // Quotes are in the books: sales roles see the products only (decision 491).
    return { lines: await listDealLines(tx, deal.id), quotes: scope.sales ? [] : await dealQuotes(tx, deal.id) };
  });
  return json(result);
});

/** Replaces a deal's products (`lines`: itemId, description, quantity, unitPrice, discountPercent); its amount becomes their total (DS7). */
export const PUT = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const body = await readJson(request);
  const result = await withCrm(request, body.organisationId, "write", (tx, { scope }) => setDealLines(tx, opportunityId, { lines: body.lines }, scope));
  return json(result);
});
