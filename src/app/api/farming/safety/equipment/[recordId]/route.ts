import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeEquipment } from "@/lib/safety/equipment";
import { safetyPeopleMap } from "@/lib/safety/people";

type Context = { params: Promise<{ recordId: string }> };

/** A new version of equipment (`expectedVersion`; `change` corrected or withdrawn with `why`). */
export const POST = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const equipment = await withFarmWork(request, body.organisationId, "read", async (tx) => changeEquipment(tx, recordId, body, await safetyPeopleMap(tx.organisationId)));
  return json({ equipment });
});
