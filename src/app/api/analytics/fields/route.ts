import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createField, FIELD_FUNCTIONS, listFields, publicField } from "@/lib/analytics/calculated-fields";
import { hiddenFarmTables } from "@/lib/analytics/farm-access";

/**
 * Calculated fields on the data sources (decision 772). Viewers and up (they
 * can see the tables); report viewers use them only through their reports'
 * saved tiles. Tables a member can't use (farm tables, decision 744) are left out.
 */
export const GET = route(async (request) => {
  const fields = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    const hidden = await hiddenFarmTables(tx);
    return (await listFields(tx)).filter((field) => !hidden?.has(field.table));
  });
  return json({ fields: fields.map(publicField), functions: FIELD_FUNCTIONS });
});

/** Saves a calculated field on a table: { table, name, formula, description? }. Bookkeepers and up. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const field = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createField(tx, body));
  return json({ field: publicField(field) }, { status: 201 });
});
