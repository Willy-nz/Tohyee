import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createRelationship } from "@/lib/analytics/relationships";
import { loadModel } from "@/lib/analytics/model";

/** Relationships between tables (decision 774). Viewers and up (they can see the tables); farm tables a member can't use are left out. */
export const GET = route(async (request) => {
  const model = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => loadModel(tx));
  return json({ relationships: model.relationships.map((relationship) => ({ id: relationship.id, table: relationship.table, field: relationship.field, dimension: relationship.dimension, dimensionField: relationship.dimensionField, name: relationship.name })) });
});

/** Saves a relationship after checking it on the data: { table, field, dimension, dimensionField, name }. Bookkeepers and up. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const saved = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createRelationship(tx, body));
  return json(saved, { status: 201 });
});
