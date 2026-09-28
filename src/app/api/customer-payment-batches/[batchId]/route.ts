import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getPaymentBatch } from "@/lib/payments/batches";

type Context = { params: Promise<{ batchId: string }> };

/** GET: one payment for several invoices, with each one's part. */
export const GET = route<Context>(async (request, context) => {
  const { batchId } = await context.params;
  const params = searchParams(request);
  const batch = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => getPaymentBatch(tx, "customer", batchId));
  return json({ batch });
});
