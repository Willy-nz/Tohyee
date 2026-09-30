import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateEmailTemplate } from "@/lib/email/settings";

/** PUT: saves one document type's email template, or `reset: true` for Tohyee's default. Admins only. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const templates = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateEmailTemplate(tx, { kind: body.kind, subject: body.subject, body: body.body, reset: body.reset }),
  );
  return json({ templates });
});
