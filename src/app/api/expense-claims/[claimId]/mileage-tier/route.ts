import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setMileageTier } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string }> };

/** POST: an admin's tier for a draft claim's mileage line (`lineOrder`, `tier` tier1, tier2 or empty to work it out). */
export const POST = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const body = await readJson(request);
  const claim = await withOrganisation(request, body.organisationId, "admin", (tx, { membership }) =>
    setMileageTier(tx, membership.role, claimId, { lineOrder: body.lineOrder, tier: body.tier }),
  );
  return json({ claim });
});
