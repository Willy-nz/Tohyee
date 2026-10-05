import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approveBill } from "@/lib/bills/service";

type Context = { params: Promise<{ billId: string }> };

/**
 * Approves a draft: posts its journal on the bill date. A likely duplicate
 * (DU2, DU3) is refused unless `approveDespiteWarnings` is true.
 */
export const POST = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    approveBill(tx, billId, { source: body.source, idempotencyKey: body.idempotencyKey, approveDespiteWarnings: body.approveDespiteWarnings }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
