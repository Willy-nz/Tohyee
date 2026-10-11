import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { approveValuation, previewValuation } from "@/lib/livestock/valuation";

/** GET: the valuation for the year ending `yearEnd`: workings, the journal it would post, and anything stopping approval (LV4-LV12). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const valuation = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => previewValuation(tx, { yearEnd: params.get("yearEnd") }));
  return json({ valuation });
});

/** Approves the valuation and posts its journal at the year end, once. Admins (the accountant). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    approveValuation(tx, { yearEnd: body.yearEnd, source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
