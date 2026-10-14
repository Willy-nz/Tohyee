import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { allocateLandedCost, billStockReceiptCount, listLandedCostAllocations } from "@/lib/inventory/landed-cost";

type Context = { params: Promise<{ billId: string }> };

/** The landed cost spread over this bill's stock so far, and how many stock lines it received. */
export const GET = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => ({
    stockLines: await billStockReceiptCount(tx, billId),
    allocations: await listLandedCostAllocations(tx, billId),
  }));
  return json(result);
});

/**
 * Spreads a landed cost (freight, duty, insurance; excluding GST) over this
 * approved bill's stock, by `method` ("value" or "quantity"), crediting
 * `offsetAccountCode` (examples LDC1-LDC5).
 */
export const POST = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    allocateLandedCost(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      billId,
      amount: body.amount,
      method: body.method,
      offsetAccountCode: body.offsetAccountCode,
      allocationDate: body.allocationDate,
      reference: body.reference,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
