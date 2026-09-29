import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { linkProjectExpense } from "@/lib/projects/service";

type Context = { params: Promise<{ projectId: string }> };

/** Puts a bill line, expense claim receipt or spend money line on the project (PJ4). It isn't re-posted. */
export const POST = route<Context>(async (request, context) => {
  const { projectId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    linkProjectExpense(tx, projectId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      sourceType: body.sourceType,
      lineId: body.lineId,
      chargeable: body.chargeable,
      markupPercent: body.markupPercent,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
