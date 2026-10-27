import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addChecklist } from "@/lib/safety/equipment";

/** Adds a pre-start checklist (`farmId`, or none for every farm; `title`; `items` with `text` and `critical`). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const checklist = await withFarmWork(request, body.organisationId, "read", (tx) => addChecklist(tx, body));
  return json({ checklist }, { status: 201 });
});
