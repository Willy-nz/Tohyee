import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { endOverheadRule } from "@/lib/rd/overheads";

type Context = { params: Promise<{ ruleId: string }> };

/** POST: ends a rule on `effectiveTo` (bookkeepers and above). It's kept and still applies up to that date. */
export const POST = route<Context>(async (request, context) => {
  const { ruleId } = await context.params;
  const body = await readJson(request);
  const rule = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => endOverheadRule(tx, ruleId, body));
  return json({ rule });
});
