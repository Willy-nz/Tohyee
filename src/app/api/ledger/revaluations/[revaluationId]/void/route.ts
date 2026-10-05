import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidFxRevaluation } from "@/lib/ledger/fx-revaluation";

type Context = { params: Promise<{ revaluationId: string }> };

/** Voids an FX revaluation, the whole run (FXB12): posts the exact reversal of its journal and of its reversal journal. */
export const POST = route<Context>(async (request, context) => {
  const { revaluationId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidFxRevaluation(tx, revaluationId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
