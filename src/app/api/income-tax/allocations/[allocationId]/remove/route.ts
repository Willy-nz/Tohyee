import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeAllocation } from "@/lib/tax/income/allocations";

type Context = { params: Promise<{ allocationId: string }> };

/** POST: takes an allocation off with a `reason`; that part of the payment is awaiting reconciliation again (owners and admins; ITX6G). */
export const POST = route<Context>(async (request, context) => {
  const { allocationId } = await context.params;
  const body = await readJson(request);
  const allocation = await withOrganisation(request, body.organisationId, "admin", (tx) => removeAllocation(tx, { allocationId, reason: body.reason }));
  return json({ allocation });
});
