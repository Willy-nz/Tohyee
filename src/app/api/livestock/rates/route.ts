import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listRates, setRate } from "@/lib/livestock/valuation";

/** GET: IRD's national average market values and national standard costs, optionally for one `incomeYear`. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const rates = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listRates(tx, { incomeYear: params.get("incomeYear") }));
  return json({ rates });
});

/** Adds or corrects a rate, with where it came from; refused once a valuation using that year is approved. Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const rate = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    setRate(tx, { incomeYear: body.incomeYear, rateKind: body.rateKind, kind: body.kind, category: body.category, amount: body.amount, source: body.source }),
  );
  return json({ rate });
});
