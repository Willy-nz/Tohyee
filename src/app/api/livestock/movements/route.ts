import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listMovements, recordMovement } from "@/lib/livestock/movements";

/** GET: movements, newest first, optionally `from` and `to` dates; `includeVoided=true` shows voided ones too. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const movements = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listMovements(tx, { from: params.get("from"), to: params.get("to"), includeVoided: params.get("includeVoided") }),
  );
  return json({ movements });
});

/** Records a birth, purchase, sale, death, missing or found stock, a class change, a move, or stock held for others (LV1, LV3). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => recordMovement(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
