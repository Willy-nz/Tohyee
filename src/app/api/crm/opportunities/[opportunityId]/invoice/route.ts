import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { makeInvoiceFromOpportunity } from "@/lib/crm/service";

type Context = { params: Promise<{ opportunityId: string }> };

/** Makes a draft invoice from a won opportunity; again returns the same one (example CRM5). */
export const POST = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    makeInvoiceFromOpportunity(tx, opportunityId, { exchangeRate: body.exchangeRate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
