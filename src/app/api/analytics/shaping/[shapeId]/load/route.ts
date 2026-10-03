import { json, readJson, route } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { runShapedTableAndDependents } from "@/lib/analytics/shaped-tables";

type Context = { params: Promise<{ shapeId: string }> };

export const POST = route<Context>(async (request, context) => {
  const { shapeId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const run = await runShapedTableAndDependents(organisation, actor, /^\d{1,18}$/.test(shapeId) ? shapeId : "0");
  return json({ run });
});
