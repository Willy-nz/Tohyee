import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { signIn } from "@/lib/safety/inductions";

/** Signs in on site: yourself, or someone without a login (`person`). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const visit = await withFarmWork(request, body.organisationId, "read", (tx) => signIn(tx, body));
  return json({ visit }, { status: 201 });
});
