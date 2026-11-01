import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { makeUploadLogin, removeUploadLogin } from "@/lib/security-cameras/cameras";

type Context = { params: Promise<{ cameraId: string }> };

/**
 * POST: makes (or replaces) the camera's upload login. The password is in
 * this answer only; it's kept as a hash. Owners and admins. Refused on the
 * demo farm, which takes no uploads.
 */
export const POST = route<Context>(async (request, context) => {
  const { cameraId } = await context.params;
  const body = await readJson(request);
  const made = await withFarmWork(request, body.organisationId, "read", (tx) => makeUploadLogin(tx, cameraId));
  return json(made, { status: 201 });
});

/** DELETE: removes the camera's upload login, so it can't upload. Owners and admins. */
export const DELETE = route<Context>(async (request, context) => {
  const { cameraId } = await context.params;
  const camera = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => removeUploadLogin(tx, cameraId));
  return json({ camera });
});
