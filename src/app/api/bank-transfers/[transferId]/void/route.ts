import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidTransfer } from "@/lib/bank/transactions";

type Context = { params: Promise<{ transferId: string }> };

/** Voids a transfer on `voidDate` (not while reconciled): posts the exact reversal. */
export const POST = route<Context>(async (request, context) => {
  const { transferId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidTransfer(tx, transferId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
