import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { optionalFormFile, readUploadForm } from "@/lib/api/upload";
import { dropWeatherAnalytics } from "@/lib/weather/analytics-drop";
import { deleteForecastRecords, turnOffRecords, turnOnRecords } from "@/lib/weather/service";

/**
 * POST (multipart form): turns keeping forecast records on, for an
 * organisation with MetService's written permission (decision 1547):
 * `organisationId`, `grantedOn`, `reference` and optionally `file`. Admins.
 */
export const POST = route(async (request) => {
  const form = await readUploadForm(request);
  const file = await optionalFormFile(form);
  const setup = await withOrganisation(request, form.get("organisationId"), "admin", (tx) => turnOnRecords(tx, { grantedOn: form.get("grantedOn"), reference: form.get("reference"), file }));
  return json({ setup });
});

/** PATCH: turns keeping records off; `deleteRecords` (default true) deletes them too (decision 1548). Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) => turnOffRecords(tx, { deleteRecords: body.deleteRecords }));
  await dropWeatherAnalytics(String(body.organisationId));
  return json({ setup });
});

/** DELETE: deletes every kept forecast record now. Admins. */
export const DELETE = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const setup = await withOrganisation(request, organisationId, "admin", (tx) => deleteForecastRecords(tx));
  await dropWeatherAnalytics(String(organisationId));
  return json({ setup });
});
