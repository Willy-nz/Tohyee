import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeLogRecord } from "@/lib/effluent/log";

type Context = { params: Promise<{ recordId: string }> };

/** PATCH: a new version of a pond or sump reading (`step`, `expectedVersion`, `why` for a correction or withdrawal). */
export const PATCH = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", (tx) => changeLogRecord(tx, "effluent_pond_reading", recordId, body));
  return json({ record });
});
