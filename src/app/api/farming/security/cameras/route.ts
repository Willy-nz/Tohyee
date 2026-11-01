import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { securityAccess } from "@/lib/security-cameras/access";
import { addCamera, listCameras } from "@/lib/security-cameras/cameras";
import { receiverSettings } from "@/lib/security-cameras/receiver";

/** Whether this server takes camera uploads, for those who set cameras up. Never the certificate's place. */
function uploadsOnThisServer() {
  const settings = receiverSettings(process.env);
  if ("off" in settings) return { on: false, why: settings.off, port: null, ftps: false, publicAddress: null };
  return { on: true, why: null, port: settings.port, ftps: settings.certPath !== null, publicAddress: settings.publicAddress };
}

/*
 * Farm security cameras (#508, decisions 1216 and 1220). Everyone on the
 * farm reaches these routes; what they may do is decided by their camera
 * access (src/lib/security-cameras/access.ts), checked in every service.
 */

/** GET `?farmId=` (or none for every farm the person sees): the cameras, with when each last uploaded, the person's camera rights and (for owners and admins) whether this server takes uploads. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withFarmWork(request, params.get("organisationId"), "read", async (tx) => {
    const cameras = await listCameras(tx, { farmId: params.get("farmId") });
    const access = await securityAccess(tx);
    return { cameras, access, uploads: access.configure ? uploadsOnThisServer() : null };
  });
  return json(result);
});

/** POST: adds a camera to a farm. Owners and admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const camera = await withFarmWork(request, body.organisationId, "read", (tx) => addCamera(tx, body));
  return json({ camera }, { status: 201 });
});
