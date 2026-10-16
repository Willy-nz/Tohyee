import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { saveIncomeTaxYear } from "@/lib/tax/income/service";

/** PUT: what IRD has for an income year, typed in (owners and admins; ITX3-ITX6). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const year = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    saveIncomeTaxYear(tx, {
      incomeYear: body.incomeYear,
      assessedRit: body.assessedRit,
      returnFiledOn: body.returnFiledOn,
      lossesBroughtForward: body.lossesBroughtForward,
      taxCredits: body.taxCredits,
      otherIncome: body.otherIncome,
      version: body.version,
    }),
  );
  return json({ year });
});
