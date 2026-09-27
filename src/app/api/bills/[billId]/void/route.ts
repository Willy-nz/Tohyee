import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidBill } from "@/lib/bills/service";

type Context = { params: Promise<{ billId: string }> };

/** Voids an approved bill: posts the exact reversal of its journal on `voidDate`. */
export const POST = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidBill(tx, billId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
