import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { equipmentChecks } from "@/lib/safety/equipment";

type Context = { params: Promise<{ recordId: string }> };

/** GET: a piece of equipment's pre-start checks, newest first, each with the questions as asked. */
export const GET = route<Context>(async (request, context) => {
  const { recordId } = await context.params;
  const checks = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => equipmentChecks(tx, recordId));
  return json({ checks });
});
