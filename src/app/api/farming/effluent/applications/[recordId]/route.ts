import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { changeApplication } from "@/lib/effluent/log";

type Context = { params: Promise<{ recordId: string }> };

/** PATCH: a new version of an irrigation, tanker or spreader run (`step`, `expectedVersion`, `why` for a correction or withdrawal). */
export const PATCH = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const body = await readJson(request);
  const record = await withFarmWork(request, body.organisationId, "read", (tx) => changeApplication(tx, recordId, body));
  return json({ record });
});
