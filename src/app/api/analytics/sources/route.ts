import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { createSource, listSources, sourcesForViewer } from "@/lib/analytics/sources";

export const GET = route(async (request) => {
  const sources = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx, { membership }) => {
    const all = await listSources(tx);
    return roleAtLeast(membership.role, "admin") ? all : sourcesForViewer(all);
  });
  return json({ sources });
});

/**
 * Sets up a file to load (name, tableName, fileName, delimiter, columns, reloadDaily), or a
 * database table or query (connectionId, schema and table or query, rowLimit). Admins and owners.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const source = await withOrganisation(request, body.organisationId, "admin", (tx) => createSource(tx, body));
  return json({ source }, { status: 201 });
});
