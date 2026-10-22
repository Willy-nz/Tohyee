import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { saveFieldSettings } from "@/lib/analytics/field-settings";
import { listTables } from "@/lib/analytics/engine";
import { listFields, withFields } from "@/lib/analytics/calculated-fields";
import { requireAnalyticsTable } from "@/lib/analytics/farm-access";

/**
 * Saves a field's settings (decision 775): { table, field, settings: { sortBy?,
 * summarise?, number?, folder?, description? } }. They're listed with the
 * table's columns (`/api/analytics/tables`). Bookkeepers and up.
 */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const saved = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => {
    await requireAnalyticsTable(tx, body.table);
    const tables = await listTables(tx.organisationId);
    // Calculated fields can have settings too.
    return saveFieldSettings(tx, body, withFields(tables, await listFields(tx, tables)));
  });
  return json({ fieldSettings: saved });
});
