import { json, readJson, route, searchParams, withOrganisation, withOrganisationRunner } from "@/lib/api/http";
import { getOrganisationEmailSettings, listEmailTemplates, prepareSmtpServer, updateOrganisationEmailSettings } from "@/lib/email/settings";

/**
 * GET: the organisation's email account (never its password) and templates.
 * PUT: saves the SMTP account (and makes it the way documents are sent); a
 * blank password keeps the saved one, `clear: true` removes everything, and
 * `sendingMethod` alone switches between SMTP and the connected Microsoft
 * mailbox (with the from name and reply-to). Admins only. The SMTP server
 * is checked (port, and that it isn't on this server's network unless a
 * server admin allows a local mail relay) before the transaction, since
 * that looks the name up in DNS.
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
  const settings = await withOrganisationRunner(request, body.organisationId, "admin", async (run) => {
    const savingSmtp = body.clear !== true && body.sendingMethod === undefined;
    const server = savingSmtp ? await prepareSmtpServer({ host: body.host, port: body.port, security: body.security }) : undefined;
    return run((tx) =>
      updateOrganisationEmailSettings(
        tx,
        {
          fromName: body.fromName,
          fromAddress: body.fromAddress,
          replyTo: body.replyTo,
          username: body.username,
          password: body.password,
          clear: body.clear,
          sendingMethod: body.sendingMethod,
        },
        server,
      ),
    );
  });
  return json({ settings });
});
