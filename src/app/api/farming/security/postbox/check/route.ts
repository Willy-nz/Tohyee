import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { collectFromPostboxById } from "@/lib/camera-postbox/collector";
import { postboxStatus } from "@/lib/camera-postbox/service";

/** POST: checks the post box now (pushes camera logins, collects what's waiting) instead of waiting for the next minute. Owners and admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  await withFarmWork(request, body.organisationId, "read", (tx) => postboxStatus(tx));
  const result = await collectFromPostboxById(String(body.organisationId));
  const status = await withFarmWork(request, body.organisationId, "read", (tx) => postboxStatus(tx));
  return json({ status, result });
});
