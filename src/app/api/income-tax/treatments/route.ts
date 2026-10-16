import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listAccountTreatments, setAccountTreatment } from "@/lib/tax/income/service";

/** GET: how each income and expense account counts for income tax (owners and admins; ITX2). */
export const GET = route(async (request) => {
  const treatments = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => listAccountTreatments(tx));
  return json({ treatments });
});

/** PUT: sets an account's income tax treatment (owners and admins; ITX2). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const treatment = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    setAccountTreatment(tx, { accountId: body.accountId, treatment: body.treatment, businessUsePercent: body.businessUsePercent }),
  );
  return json({ treatment });
});
