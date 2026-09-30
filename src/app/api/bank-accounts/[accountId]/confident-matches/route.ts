import { json, readJson, route, searchParams, withOrganisation, withOrganisationRunner } from "@/lib/api/http";
import { confidentMatches, okConfidentMatches } from "@/lib/bank/confident";

type Context = { params: Promise<{ accountId: string }> };

/** GET: every unreconciled line with its one-click ("OK") suggestion, or how many candidates it has (examples BK17). */
export const GET = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const lines = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => confidentMatches(tx, accountId));
  return json({ lines, confidentCount: lines.filter((line) => line.suggestion).length });
});

/**
 * POST: "OK all confident matches" (example BK19). Each line is reconciled in
 * its own transaction; the result lists what happened to each. `items` are
 * `{ lineId, expect }` as shown (the suggestion's key); without them every
 * line confident now is done.
 */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisationRunner(request, body.organisationId, "bookkeeper", (run) => okConfidentMatches(run, accountId, body));
  return json(result);
});
