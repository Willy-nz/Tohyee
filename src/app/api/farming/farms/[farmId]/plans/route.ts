import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createPlan, listPlans } from "@/lib/farming/fertiliser";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's fertiliser plans. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const plans = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listPlans(tx, { farmId }));
  return json({ plans });
});

/** Adds a plan (`name`). Its lines are saved as versions. Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const plan = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createPlan(tx, { farmId, name: body.name }));
  return json({ plan }, { status: 201 });
});
