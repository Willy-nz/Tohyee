import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { removeShapedTable, runShapedTable, updateShapedTable } from "@/lib/analytics/shaped-tables";

type Context = { params: Promise<{ shapeId: string }> };

function shapeIdFrom(value: string): string {
  return /^\d{1,18}$/.test(value) ? value : "0";
}

export const PATCH = route<Context>(async (request, context) => {
  const id = shapeIdFrom((await context.params).shapeId);
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "bookkeeper");
  const shape = await withOrganisation(request, organisation.id, "bookkeeper", (tx) => updateShapedTable(tx, id, body));
  const run = await runShapedTable(organisation, actor, shape.id, "manual");
  return json({ shape, run });
});

export const DELETE = route<Context>(async (request, context) => {
  const id = shapeIdFrom((await context.params).shapeId);
  const { organisation, actor } = await analyticsMember(request, searchParams(request).get("organisationId"), "bookkeeper");
  await removeShapedTable(organisation, actor, id);
  return json({ ok: true });
});
