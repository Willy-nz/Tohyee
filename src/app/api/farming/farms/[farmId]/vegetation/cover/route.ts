import { json, readJson, route, searchParams, withFarmWork, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { coverCheck, turnOffCoverEstimates, turnOnCoverEstimates } from "@/lib/farming/vegetation/cover-model";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's modelled-cover line, how far off it's been on dates and farms it wasn't fitted on, and the line in use (MCV3-MCV5). Read-only. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const check = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => coverCheck(tx, farmId));
  return json({ check });
});

/** POST `action: "on"` with `acceptableError` (kg DM/ha) turns estimates on if the line did that well; `action: "off"` turns them off (MCV7). Owners and admins. */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  if (body.action === "on") {
    const model = await withOrganisation(request, body.organisationId, "admin", (tx) => turnOnCoverEstimates(tx, farmId, { acceptableError: body.acceptableError }));
    return json({ model });
  }
  if (body.action === "off") {
    await withOrganisation(request, body.organisationId, "admin", (tx) => turnOffCoverEstimates(tx, farmId));
    return json({ model: null });
  }
  throw new ValidationError("Choose on or off.");
});
