import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getMetaApp, saveMetaApp } from "@/lib/analytics/meta";

/** GET: the organisation's Meta app (App ID and configuration ID; the secret never). Admins and owners. */
export const GET = route(async (request) => json(await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => getMetaApp(tx))));

/** PUT: saves the Meta app. Body: { organisationId, appId, appSecret?, configId? }; a blank secret keeps the saved one. Admins and owners. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  return json(await withOrganisation(request, body.organisationId, "admin", (tx) => saveMetaApp(tx, { appId: body.appId, appSecret: body.appSecret, configId: body.configId })));
});
