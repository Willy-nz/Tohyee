import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { checkSafetyHistory } from "@/lib/safety/records";

/**
 * GET: checks the whole safety history (every hash worked out again).
 * `seq` and `hash` from an earlier copy (e.g. the weekly email) are looked
 * up too. Only numbers and kinds come back, never details.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const copy = params.get("seq") || params.get("hash") ? { seq: params.get("seq") ?? "", hash: params.get("hash") ?? "" } : null;
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => checkSafetyHistory(tx, copy));
  return json({ report });
});
