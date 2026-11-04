import { json, readJson, route, searchParams, withFarmWork, withOrganisation } from "@/lib/api/http";
import { getFarmTerms, setFarmTerms } from "@/lib/farming/timeline";

/** GET: the organisation's farm words (display only; decision 1448). */
export const GET = route(async (request) => {
  const terms = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => getFarmTerms(tx));
  return json({ terms });
});

/** PUT `{ terms: [{ key, label }] }`: renames words; a blank label goes back to Tohyee's. Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const terms = await withOrganisation(request, body.organisationId, "admin", (tx) => setFarmTerms(tx, { terms: body.terms }));
  return json({ terms });
});
