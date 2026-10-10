import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createEmailTemplate, listEmailTemplates, MERGE_FIELD_LABELS } from "@/lib/crm/sales-email";

/** Email templates (decision 496): everyone in the CRM sees the ones switched on; admins also see the others. */
export const GET = route(async (request) => {
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { scope }) => ({
    templates: await listEmailTemplates(tx, { includeInactive: scope.canAdmin }),
    mergeFields: MERGE_FIELD_LABELS,
  }));
  return json(result);
});

/** Adds a template: `name`, `subject`, `body` (merge fields like {{first_name}}). Admins and owners only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const template = await withCrm(request, body.organisationId, "admin", (tx) => createEmailTemplate(tx, { name: body.name, subject: body.subject, body: body.body }));
  return json({ template }, { status: 201 });
});
