import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listHighPriced, recordHighPriced } from "@/lib/livestock/high-priced";

/** GET: high-priced animals (LV25). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const animals = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listHighPriced(tx));
  return json({ animals });
});

/** Records a high-priced animal with IRD's depreciation rate and its source (LV25). Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const animal = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    recordHighPriced(tx, {
      kind: body.kind,
      classCode: body.classCode,
      description: body.description,
      boughtOn: body.boughtOn,
      cost: body.cost,
      ratePercent: body.ratePercent,
      rateSource: body.rateSource,
      priorYearNamv: body.priorYearNamv,
    }),
  );
  return json({ animal }, { status: 201 });
});
