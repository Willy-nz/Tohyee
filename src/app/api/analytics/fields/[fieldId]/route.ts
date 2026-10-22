import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteField, publicField, updateField } from "@/lib/analytics/calculated-fields";

type Context = { params: Promise<{ fieldId: string }> };

/**
 * Changes a calculated field's formula, name or description (decision 772).
 * It's shared, so every tile using it shows the change; the answer lists the
 * reports and saved values that use it. Renaming one in use, or changing its
 * kind of value, is refused. Bookkeepers and up.
 */
export const PATCH = route<Context>(async (request, context) => {
  const { fieldId } = await context.params;
  const body = await readJson(request);
  const field = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateField(tx, fieldId, body));
  return json({ field: { ...publicField(field), usedBy: field.usedBy } });
});

/** Removes a calculated field that nothing uses (one in use is refused, naming what uses it). */
export const DELETE = route<Context>(async (request, context) => {
  const { fieldId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteField(tx, fieldId));
  return json({ ok: true });
});
