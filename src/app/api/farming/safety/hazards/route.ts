import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addHazard } from "@/lib/safety/hazards";

/** Adds a hazard or no-go zone to a farm (`farmId`, `title`, `level`, ...). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const hazard = await withFarmWork(request, body.organisationId, "read", (tx) => addHazard(tx, body));
  return json({ hazard }, { status: 201 });
});
