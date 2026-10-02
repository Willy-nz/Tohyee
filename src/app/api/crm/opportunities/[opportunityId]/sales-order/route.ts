import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { makeSalesOrderFromOpportunity } from "@/lib/crm/service";

type Context = { params: Promise<{ opportunityId: string }> };

/** Makes a draft sales order from a won opportunity instead of an invoice; again returns the same one (CRM5b, decision 327). */
export const POST = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => makeSalesOrderFromOpportunity(tx, opportunityId));
  return json(result, { status: result.created ? 201 : 200 });
});
