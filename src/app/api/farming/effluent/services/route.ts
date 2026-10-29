import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { addService } from "@/lib/effluent/care";

/** POST: records a service, repair or Effluent WoF done on a system (`systemId`, `kind`, `doneOn`, `by`, `notes`, `nextDue`, `files`). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", (tx) => addService(tx, body));
  return json({ record }, { status: 201 });
});
