import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listStaffRates, setStaffRate } from "@/lib/projects/service";

/** GET: the organisation's members with their staff cost rate per hour (PJ3). */
export const GET = route(async (request) => {
  const rates = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listStaffRates(tx));
  return json({ rates });
});

/** Sets a member's cost rate per hour. Admins only; time entered afterwards uses it. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const rates = await withOrganisation(request, body.organisationId, "admin", (tx, { membership }) =>
    setStaffRate(tx, membership.role, { userId: body.userId, costRate: body.costRate }),
  );
  return json({ rates });
});
