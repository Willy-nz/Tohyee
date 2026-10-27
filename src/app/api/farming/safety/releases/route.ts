import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { releaseEquipment } from "@/lib/safety/equipment";

/** Releases equipment after a failed check (`equipmentId`, `whatWasDone`, `files`): owners, admins or members named on it. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const release = await withFarmWork(request, body.organisationId, "read", (tx) => releaseEquipment(tx, body));
  return json({ release }, { status: 201 });
});
