import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeUnavailability } from "@/lib/payroll/rosters";

type Context = { params: Promise<{ unavailabilityId: string }> };

export const DELETE = route<Context>(async (request, context) => {
  const { unavailabilityId } = await context.params;
  const body = await readJson(request);
  const unavailability = await withOrganisation(request, body.organisationId, "viewer", (tx) => removeUnavailability(tx, unavailabilityId));
  return json({ unavailability });
});
