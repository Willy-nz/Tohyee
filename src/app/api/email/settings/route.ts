import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getOrganisationEmailSettings, listEmailTemplates, updateOrganisationEmailSettings } from "@/lib/email/settings";

/**
 * GET: the organisation's email account (never its password) and templates.
 * PUT: saves the account; a blank password keeps the saved one, `clear: true`
 * removes it. Admins only.
 */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", async (tx) => ({
    settings: await getOrganisationEmailSettings(tx),
    templates: await listEmailTemplates(tx),
  }));
  return json(result);
});

export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateOrganisationEmailSettings(tx, {
      fromName: body.fromName,
      fromAddress: body.fromAddress,
      replyTo: body.replyTo,
      host: body.host,
      port: body.port,
      security: body.security,
      username: body.username,
      password: body.password,
      clear: body.clear,
    }),
  );
  return json({ settings });
});
