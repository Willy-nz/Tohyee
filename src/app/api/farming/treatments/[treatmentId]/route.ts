import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { removeTreatment } from "@/lib/farming/treatments";

type Context = { params: Promise<{ treatmentId: string }> };

/** PATCH `{ removed: true, reason }`: removes a treatment recorded by mistake (kept, marked removed). Bookkeepers and up (checked in the service). */
export const PATCH = route<Context>(async (request, context) => {
  const { treatmentId } = await context.params;
  const body = await readJson(request);
  const treatment = await withFarmWork(request, body.organisationId, "record", (tx) => removeTreatment(tx, treatmentId, { reason: body.reason }));
  return json({ treatment });
});
