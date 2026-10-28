import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeTractorEquipment } from "@/lib/farming/tractor";

type Context = { params: Promise<{ equipmentId: string }> };

/** Changes equipment. A new `widthM`, `lateralM` or `backM` adds a timestamped version; old jobs keep theirs. `retired: true` retires it. */
export const PATCH = route<Context>(async (request, context) => {
  const { equipmentId } = await context.params;
  const body = await readJson(request);
  const equipment = await withFarmWork(request, body.organisationId, "record", (tx) => changeTractorEquipment(tx, equipmentId, body));
  return json({ equipment });
});
