import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createSource, listSources } from "@/lib/analytics/sources";

export const GET = route(async (request) => {
  const sources = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listSources(tx));
  return json({ sources });
});

/** Sets up a file to load (name, tableName, fileName, delimiter, columns, reloadDaily). Admins and owners. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const source = await withOrganisation(request, body.organisationId, "admin", (tx) => createSource(tx, body));
  return json({ source }, { status: 201 });
});
