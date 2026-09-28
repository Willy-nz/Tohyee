import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidPaymentBatch } from "@/lib/payments/batches";

type Context = { params: Promise<{ batchId: string }> };

/** Voids the whole payment: posts the exact reversal of its journal on `voidDate` and voids every bill's part. */
export const POST = route<Context>(async (request, context) => {
  const { batchId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidPaymentBatch(tx, "supplier", batchId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
