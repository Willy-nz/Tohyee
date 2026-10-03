import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { analyticsMember } from "@/lib/analytics/http";
import { listShapedTables, createShapedTable, runShapedTableAndDependents } from "@/lib/analytics/shaped-tables";
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

/** Creates and immediately builds a shaped table. Admins and owners, like data sources. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisation, actor } = await analyticsMember(request, body.organisationId, "admin");
  const shape = await withOrganisation(request, organisation.id, "admin", (tx) => createShapedTable(tx, body));
  const run = await runShapedTableAndDependents(organisation, actor, shape.id);
  return json({ shape, run }, { status: 201 });
});
