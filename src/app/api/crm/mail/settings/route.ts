import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { getMailSettings, saveMailSettings } from "@/lib/crm/mail/service";

/** The organisation's Google and Microsoft app, without secrets (example MAIL1). Admins only. */
export const GET = route(async (request) => {
  const settings = await withCrm(request, searchParams(request).get("organisationId"), "admin", (tx) => getMailSettings(tx));
  return json({ settings });
});

export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withCrm(request, body.organisationId, "admin", (tx) =>
    saveMailSettings(tx, {
      googleClientId: body.googleClientId,
      googleClientSecret: body.googleClientSecret,
      microsoftClientId: body.microsoftClientId,
      microsoftClientSecret: body.microsoftClientSecret,
      microsoftTenant: body.microsoftTenant,
    }),
  );
  return json({ settings });
});
