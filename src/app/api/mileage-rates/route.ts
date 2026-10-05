import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listMileageRates } from "@/lib/expense-claims/mileage";
import { saveMileageRates } from "@/lib/expense-claims/mileage-rates";

/** GET: the kilometre rates per income year and vehicle type (MI1). Viewers and above. */
export const GET = route(async (request) => {
  const rates = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listMileageRates(tx));
  return json({ rates });
});

/**
 * PUT: one income year's rates (admins, MI1): `yearEnding` (e.g. 2027 for
 * 2026-27) and `rates` { petrol, diesel, petrol_hybrid, electric: { tier1Rate,
 * tier2Rate } }. Refused for a year an approved claim used; draft claims'
 * mileage is worked out again (MI6).
 */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx, { membership }) =>
    saveMileageRates(tx, membership.role, { yearEnding: body.yearEnding, rates: body.rates }),
  );
  return json(result);
});
