import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { undoDisposal } from "@/lib/fixed-assets/runs";

type Context = { params: Promise<{ assetId: string }> };

/** Undoes the asset's disposal with the exact reversal on the disposal date (FA11). */
export const POST = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    undoDisposal(tx, assetId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
