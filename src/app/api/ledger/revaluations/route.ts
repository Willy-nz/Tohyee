import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listFxRevaluations, postFxRevaluation } from "@/lib/ledger/fx-revaluation";

export const GET = route(async (request) => {
  const params = searchParams(request);
  const revaluations = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listFxRevaluations(tx, {
      revaluationDateFrom: params.get("revaluationDateFrom"),
      revaluationDateTo: params.get("revaluationDateTo"),
    }),
  );
  return json({ revaluations });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    postFxRevaluation(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      reference: body.reference,
      description: body.description,
      revaluationDate: body.revaluationDate,
      reversalPostingDate: body.reversalPostingDate,
      rateDate: body.rateDate,
      rateSource: body.rateSource,
      unrealisedGainAccountCode: body.unrealisedGainAccountCode,
      unrealisedLossAccountCode: body.unrealisedLossAccountCode,
      balances: body.balances,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
