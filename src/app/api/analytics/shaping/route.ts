import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listShapedTables, createShapedTable, runShapedTable } from "@/lib/analytics/shaped-tables";
import { listTables } from "@/lib/analytics/engine";

export const GET = route(async (request) => {
  const { organisation } = await analyticsMember(request, searchParams(request).get("organisationId"), "viewer");
  const shapes = await withOrganisation(request, organisation.id, "viewer", listShapedTables);
  const tables = await listTables(organisation.id);
  return json({
    shapes,
    tables: [...tables].map(([name, columns]) => ({ name, columns })),
  });
});

/** Creates and immediately builds a shaped table. Bookkeepers and up. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "bookkeeper");
  const shape = await withOrganisation(request, organisation.id, "bookkeeper", (tx) => createShapedTable(tx, body));
  const run = await runShapedTable(organisation, actor, shape.id, "manual");
  return json({ shape, run }, { status: 201 });
});
