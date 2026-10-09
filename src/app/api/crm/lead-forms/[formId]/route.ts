import { json, readJson, route, withCrm } from "@/lib/api/http";
import { updateLeadForm } from "@/lib/crm/lead-intake";

type Context = { params: Promise<{ formId: string }> };

/** Renames a form, changes its thank-you page, or switches it off (`isActive: false`) or on. Admins. */
export const PATCH = route<Context>(async (request, context) => {
  const { formId } = await context.params;
  const body = await readJson(request);
  const form = await withCrm(request, body.organisationId, "admin", (tx) =>
    updateLeadForm(tx, formId, { name: body.name, thankYouUrl: body.thankYouUrl, isActive: body.isActive }),
  );
  return json({ form });
});
