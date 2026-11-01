import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeCamera, setCameraActive } from "@/lib/security-cameras/cameras";

type Context = { params: Promise<{ cameraId: string }> };

/** PATCH: changes a camera's details, or archives (`active: false`) or restores it. Owners and admins. */
export const PATCH = route<Context>(async (request, context) => {
  const { cameraId } = await context.params;
  const body = await readJson(request);
  const camera = await withFarmWork(request, body.organisationId, "read", (tx) => (typeof body.active === "boolean" ? setCameraActive(tx, cameraId, body.active) : changeCamera(tx, cameraId, body)));
  return json({ camera });
});
