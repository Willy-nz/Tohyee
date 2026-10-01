import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createOpportunity, listOpportunities } from "@/lib/crm/service";

/** Every opportunity in pipeline order, or one company's (examples CRM3, CRM9). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const opportunities = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listOpportunities(tx, { contactId: params.get("contactId") }),
  );
  return json({ opportunities });
});

export const POST = route(async (request) => {
  const body = await readJson(request);
  const opportunity = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    createOpportunity(
      tx,
      {
      name: body.name,
      contactId: body.contactId,
      pointOfContactId: body.pointOfContactId,
      ownerUserId: body.ownerUserId,
      amount: body.amount,
      closeDate: body.closeDate,
      stage: body.stage,
      customFields: body.customFields,
      recordTypeId: body.recordTypeId,
      },
      { role: membership.role },
    ),
  );
  return json({ opportunity }, { status: 201 });
});
