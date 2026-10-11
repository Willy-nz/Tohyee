import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listElections, recordElection } from "@/lib/livestock/valuation";

/** GET: the farm's valuation methods by kind of livestock and income year. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const elections = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listElections(tx));
  return json({ elections });
});

/** Records a method from an income year; attach the evidence as files. Files nothing with IRD. Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const election = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    recordElection(tx, { kind: body.kind, method: body.method, fromIncomeYear: body.fromIncomeYear, note: body.note }),
  );
  return json({ election }, { status: 201 });
});
