import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { saveEmergency } from "@/lib/safety/hazards";

/** Saves a farm's emergency details as a new version (`farmId`, `expectedVersion` once it has some). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const emergency = await withOrganisation(request, body.organisationId, "viewer", (tx) => saveEmergency(tx, body));
  return json({ emergency });
});
