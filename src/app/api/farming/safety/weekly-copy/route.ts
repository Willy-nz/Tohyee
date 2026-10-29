import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { copySettings, saveCopySettings } from "@/lib/safety/weekly-copy";

/** GET: the weekly copy's settings and the copies sent. Viewers and above. */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => copySettings(tx));
  return json(result);
});

/** Turns the weekly copy on or off and chooses who gets it (`on`, `toAddresses`). Owners and admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) => saveCopySettings(tx, { on: body.on, toAddresses: body.toAddresses, includeEffluent: body.includeEffluent }));
  return json(result);
});
