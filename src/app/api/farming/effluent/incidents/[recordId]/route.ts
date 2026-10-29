import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeIncident } from "@/lib/effluent/care";

type Context = { params: Promise<{ recordId: string }> };

/** PATCH: a new version of an incident (`step`: update, council_told, close, reopen, correct, withdraw; `expectedVersion`). */
export const PATCH = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  return json({ record: await withFarmWork(request, body.organisationId, "read", (tx) => changeIncident(tx, recordId, body)) });
});
