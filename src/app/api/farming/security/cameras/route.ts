import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { postboxUploadTarget } from "@/lib/camera-postbox/service";
import { securityAccess } from "@/lib/security-cameras/access";
import { addCamera, listCameras } from "@/lib/security-cameras/cameras";
import type { OrgTx } from "@/lib/db/org-transaction";
import { receiverSettings } from "@/lib/security-cameras/receiver";

/** Where cameras upload, for those who set cameras up: the camera post box if one is paired (decision 1226), else this server's own receiver. Never the certificate's place. */
async function uploadsOnThisServer(tx: OrgTx) {
  const postbox = await postboxUploadTarget(tx);
  if (postbox) return { on: true, why: null, port: postbox.port, ftps: true, publicAddress: postbox.address, via: "postbox" as const };
  const settings = receiverSettings(process.env);
  if ("off" in settings) return { on: false, why: settings.off, port: null, ftps: false, publicAddress: null, via: null };
  return { on: true, why: null, port: settings.port, ftps: settings.certPath !== null, publicAddress: settings.publicAddress, via: "direct" as const };
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
    return { cameras, access, uploads: access.configure ? await uploadsOnThisServer(tx) : null };
  });
  return json(result);
});

/** POST: adds a camera to a farm. Owners and admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const camera = await withFarmWork(request, body.organisationId, "read", (tx) => addCamera(tx, body));
  return json({ camera }, { status: 201 });
});
