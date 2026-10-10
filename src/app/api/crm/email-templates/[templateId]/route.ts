import { json, readJson, route, withCrm } from "@/lib/api/http";
import { updateEmailTemplate } from "@/lib/crm/sales-email";

type Context = { params: Promise<{ templateId: string }> };

/** Changes a template, or switches it off or on (decision 496). Admins and owners only. */
export const PATCH = route<Context>(async (request, context) => {
  const { templateId } = await context.params;
  const body = await readJson(request);
  const template = await withCrm(request, body.organisationId, "admin", (tx) =>
    updateEmailTemplate(tx, templateId, { name: body.name, subject: body.subject, body: body.body, isActive: body.isActive }),
  );
  return json({ template });
});
