import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { makeSiteLink } from "@/lib/safety/inductions";

/** Makes a farm's sign-in link for visitors and contractors (`farmId`, optional `expiresOn`). The address and QR code are shown once. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  const link = await withFarmWork(request, body.organisationId, "read", (tx) => makeSiteLink(tx, body, origin));
  return json(link, { status: 201 });
});
