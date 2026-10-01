import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateOpportunity } from "@/lib/crm/service";

type Context = { params: Promise<{ opportunityId: string }> };

/** Changes an opportunity or moves it to another stage (example CRM4). */
export const PATCH = route<Context>(async (request, context) => {
  const { opportunityId } = await context.params;
  const body = await readJson(request);
  const opportunity = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateOpportunity(tx, opportunityId, {
      name: body.name,
      contactId: body.contactId,
      pointOfContactId: body.pointOfContactId,
      ownerUserId: body.ownerUserId,
      amount: body.amount,
      closeDate: body.closeDate,
      stage: body.stage,
      customFields: body.customFields,
    }),
  );
  return json({ opportunity });
});
